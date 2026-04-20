// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { retrieveCatalogue, retrieveLivingRoomSlots, retrieveKitchenSlots, retrieveBedroomSlots, retrieveKidsRoomSlots, retrieveHallwaySlots, retrieveLoftSlots, retrieveFoyerSlots, retrieveFrontyardSlots, retrieveBackyardSlots } from "@/lib/retrieval";

// Verify a product image URL is actually reachable.
// Uses HEAD with a 3s timeout. A 2xx response is sufficient — we trust the DB
// has valid image URLs, so we only gate on hard failures (4xx/5xx/network error).
// Content-type is NOT checked on HEAD (many CDNs omit it); a GET-range fallback
// is used only when HEAD itself fails (non-2xx or 405), not for missing ct headers.
async function isImageReachable(url: string): Promise<boolean> {
  if (!url || !url.startsWith("http")) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    // HEAD succeeded with 2xx — image exists, no need to check content-type
    if (res.ok) return true;
    // HEAD rejected (405) or returned error — retry with GET range
    if (res.status === 405 || res.status >= 500) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 3000);
      res = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
        signal: controller2.signal,
      });
      clearTimeout(timer2);
      return res.ok;
    }
    // 4xx other than 405 = genuinely missing/forbidden
    return false;
  } catch {
    return false;
  }
}

const CATEGORY_ALIASES: Record<string, string[]> = {
  sofa: ["sofa", "couch", "sectional", "loveseat", "settee", "modular sofa"],
  chair: ["chair", "armchair", "accent chair", "lounge chair", "recliner"],
  // lamp before table so "table lamp" / "desk lamp" titles resolve to lamp, not table
  // "light" removed — too ambiguous (matches "Light Walnut Finish", "light oak", etc.)
  lamp: ["lamp", "floor lamp", "table lamp", "pendant", "chandelier", "sconce", "lantern"],
  // nightstand is bedroom-only — removed from table alias so it never scores for living room
  table: ["table", "coffee table", "side table", "end table", "console table"],
  rug: ["rug", "carpet", "runner", "area rug"],
  // stool before bed: "EndOfBed Bench" contains "bench" AND "bed" — stool must win
  stool: ["stool", "bar stool", "ottoman", "bench", "pouf", "end of bed", "end-of-bed"],
  bed: ["bed frame", "platform bed", "daybed", "headboard", "bunk bed", "loft bed", "toddler bed", "twin bed", "queen bed", "king bed", "bed"],
  // nightstand belongs to bedroom, not generic cabinet
  nightstand: ["nightstand", "night stand", "bedside table", "nighttable"],
  // sideboard belongs to dining room, not generic cabinet
  sideboard: ["sideboard", "buffet", "dining cabinet", "china cabinet"],
  cabinet: ["cabinet", "storage cabinet", "bookshelf", "shelf", "bookcase", "tv stand", "media console", "tv console", "sideboard console"],
  dresser: ["dresser", "chest of drawers", "wardrobe", "armoire"],
  desk: ["desk", "workstation", "study table", "writing desk"],
  dining: ["dining", "dining chair", "dining table", "kitchen table"],
  mirror: ["mirror", "wall mirror", "floor mirror", "vanity mirror"],
  // "art" removed — wall art has its own slot/bucket; keeping it here caused
  // paintings to compete with vases for the decor slot in inferPrimaryCategory
  decor: ["decor", "vase", "planter", "cushion", "throw pillow", "tray", "candle"],
  wall_art: ["canvas art", "framed art", "wall art", "painting", "poster", "print", "wall hanging", "canvas sign", "metal sign", "map art"],
};

// Which categories are valid per room — used for post-filter scoring
// Any product whose title/category matches a WRONG_ROOM_TERMS entry gets score penalty
const ROOM_WRONG_TERMS: Record<string, string[]> = {
  living_room: [
    "nightstand", "night stand", "bedside", "dresser", "wardrobe", "armoire",
    "chest of drawers", "sideboard", "buffet", "dining cabinet", "bar stool",
    "shoe cabinet", "shoe rack", "entryway", "hallway", "nursery", "mattress",
    "bedding", "duvet", "comforter", "office chair",
    "filing cabinet", "file cabinet", "mobile file", "lateral file",
    "cat bed", "cat lounge", "cat tree", "dog bed", "pet bed",
    // Desks belong in office only — block all variants including those with "cabinet" in title
    "executive desk", "l shape desk", "l-shape desk", "l shaped desk",
    "writing desk", "corner desk", "computer desk", "office desk", "workstation",
    // Dining chairs belong in dining room only, not living room
    "dining chair", "dining chairs", "parson chair", "parson dining",
    // Pillow/cushion cases — soft furnishing items whose title ends in "Sofa"
    // causing inferPrimaryCategory to promote them to the sofa slot
    "pillow case", "cushion case", "cushion cover", "throw pillow", "sofa cover", "couch cover",
  ],
  bedroom: [
    "dining table", "dining chair", "coffee table", "sectional", "sofa",
    "bar stool", "office chair", "tv stand", "filing cabinet",
  ],
  dining_room: [
    "nightstand", "bedside", "dresser", "wardrobe", "office chair",
    "bar stool", "coffee table", "sectional", "sofa",
  ],
  kitchen: [
    "nightstand", "bedside", "dresser", "wardrobe", "sectional", "sofa",
    "office chair", "dining chair", "coffee table",
  ],
  office: [
    "nightstand", "bedside", "dresser", "wardrobe", "sectional", "sofa",
    "dining table", "dining chair", "bar stool", "coffee table",
  ],
  // Foyer/Loft/hallway: use multi-word furniture phrases only — bare "sofa"/"bed" match
  // art product titles like "Modern Sofa Background Canvas" causing false -50 penalty
  foyer: [
    "sofa set", "sectional sofa", "sofa couch", "loveseat",
    "bed frame", "platform bed", "mattress", "bedside table", "nightstand",
    "dining table", "dining chair", "dining set",
    "office chair", "task chair", "gaming chair",
    "bar stool", "dresser", "wardrobe", "armoire",
    "tv stand", "tv console", "media console", "television console",
    "vanity mirror", "bathroom mirror", "medicine cabinet", "makeup mirror", "lighted mirror", "led mirror", "magnifying mirror", "beveled edge",
    "desk lamp", "task lamp", "wall sconce", "sconce", "flush mount", "semi-flush", "chandelier",
  ],
  loft: [
    "sofa set", "sectional sofa", "sofa couch", "loveseat",
    "bed frame", "platform bed", "mattress", "bedside table", "nightstand",
    "dining table", "dining chair", "dining set",
    "office chair", "task chair", "gaming chair",
    "bar stool", "dresser", "wardrobe", "armoire",
    "tv stand", "tv console", "media console", "television console",
    "vanity mirror", "bathroom mirror", "medicine cabinet", "makeup mirror", "lighted mirror", "led mirror", "magnifying mirror", "beveled edge",
    "desk lamp", "task lamp", "wall sconce", "sconce", "flush mount", "semi-flush", "chandelier",
  ],
  hallway: [
    "sofa set", "sectional sofa", "sofa couch", "loveseat",
    "bed frame", "platform bed", "mattress", "bedside table", "nightstand",
    "dining table", "dining chair", "coffee table",
    "office chair", "bar stool", "dresser", "wardrobe", "armoire",
    "tv stand", "tv console", "media console", "television console",
    "vanity mirror", "bathroom mirror", "medicine cabinet", "makeup mirror", "lighted mirror", "led mirror", "magnifying mirror", "beveled edge",
    "desk lamp", "task lamp", "wall sconce", "sconce", "flush mount", "semi-flush", "chandelier",
  ],
  // Frontyard / backyard — only outdoor products, block indoor-only items
  frontyard: [
    "nightstand", "bedside", "dresser", "wardrobe",
    "dining chair", "office chair", "tv stand", "filing cabinet",
    "sofa", "sectional", "couch", "loveseat",
  ],
  backyard: [
    "nightstand", "bedside", "dresser", "wardrobe",
    "office chair", "tv stand", "filing cabinet",
    "sofa", "sectional", "couch", "loveseat",
  ],
  // Kids room — block adult-specific heavy furniture
  kids_room: [
    "sofa", "sectional", "couch", "loveseat",
    "dining table", "dining chair", "dining set",
    "office chair", "filing cabinet", "file cabinet",
    "sideboard", "buffet", "bar stool",
    "wardrobe", "armoire",
  ],
};

const SLOT_PLANS: Record<string, string[]> = {
  // wall_art added to all rooms so paintings get their own authoritative slot
  living_room: ["sofa", "chair", "table", "rug", "lamp", "cabinet", "wall_art"],
  bedroom: ["bed", "nightstand", "lamp", "dresser", "mirror", "rug", "wall_art"],
  dining_room: ["dining", "chair", "sideboard", "lamp", "rug", "wall_art"],
  kitchen: ["stool", "lamp", "decor", "cabinet", "wall_art"],
  office: ["desk", "chair", "lamp", "cabinet", "rug", "wall_art"],
  foyer: ["table", "lamp", "wall_art", "mirror", "decor", "stool", "rug"],
  loft: ["table", "lamp", "wall_art", "mirror", "decor", "stool", "rug"],
  hallway: ["wall_art", "mirror", "lamp", "rug", "table", "decor"],
  frontyard: ["chair", "lamp", "decor", "table", "rug"],
  backyard: ["chair", "table", "lamp", "decor", "stool", "rug"],
  // kids room: bed, wall art, lamp, rug, storage, decor
  kids_room: ["bed", "wall_art", "lamp", "rug", "decor", "cabinet"],
};

const HERO_WEIGHT: Record<string, number> = {
  sofa: 2.2,
  bed: 2.2,
  dining: 2,
  desk: 2,
  chair: 1.1,
  table: 1.2,
  rug: 1,
  lamp: 0.9,
  cabinet: 0.9,
  mirror: 0.7,
  wall_art: 0.8,
  decor: 0.3,
  stool: 0.8,
};

function normalizeText(value: string) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function mergedText(item: any) {
  return normalizeText([
    item?.title,
    item?.category,
    item?.normalized_category,
    item?.subcategory,
    item?.bucket,
    item?.description_text,
    item?.vendor,
  ].filter(Boolean).join(" "));
}

function extractCategories(theme: string, roomType: string) {
  const text = normalizeText(theme);
  const found: string[] = [];
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if ([category, ...aliases].some((term) => text.includes(term))) {
      found.push(category);
    }
  }
  const defaults = SLOT_PLANS[roomType] || [];
  return Array.from(new Set([...found, ...defaults])).slice(0, 7);
}

function hasImage(item: any) {
  return Boolean(item?.image_url && String(item.image_url).trim().length > 0);
}

function scoreItem(item: any, requestedCategories: string[], roomType: string, theme: string) {
  const text = mergedText(item);
  let score = Number(item?.similarity || 0);

  for (const category of requestedCategories) {
    if (text.includes(category)) score += 1.2 * (HERO_WEIGHT[category] || 1);
  }

  const roomDefaults = SLOT_PLANS[roomType] || [];
  for (const category of roomDefaults) {
    if (text.includes(category)) score += 0.35 * (HERO_WEIGHT[category] || 1);
  }

  const themeWords = normalizeText(theme).split(" ").filter((word) => word.length > 2);
  for (const word of themeWords) {
    if (text.includes(word)) score += 0.15;
  }

  // Kids/nursery penalty only applies to adult rooms — kids_room WANTS these products
  if (roomType !== "kids_room" && /\bkid|kids|nursery|toddler|children\b/.test(text)) score -= 3;
  // Outdoor penalty only applies to indoor rooms — outdoor rooms WANT patio/garden products
  const OUTDOOR_ROOMS = new Set(["frontyard", "backyard"]);
  if (!OUTDOOR_ROOMS.has(roomType) && /\boutdoor|patio|garden\b/.test(text)) score -= 2.5;
  // Pet/toy products — heavy penalty so they never reach the shortlist
  // "cat" alone catches "cat bed", "cat lounge", "cat tree" etc.
  if (/\bcat bed|cat lounge|cat tree|cat cube|dog bed|pet bed|pet furniture\b/.test(text)) score -= 50;
  if (/\btoy|pet\b/.test(text)) score -= 5;
  if (!hasImage(item)) score -= 100;

  // Heavy penalty for items that belong to a different room type
  const wrongTerms = ROOM_WRONG_TERMS[roomType] || [];
  for (const term of wrongTerms) {
    if (text.includes(term.toLowerCase())) {
      score -= 50; // effectively removes from shortlist
      break;
    }
  }

  return score;
}

function inferPrimaryCategory(item: any): string {
  const text = mergedText(item);
  // Pre-check multi-word phrases that contain shorter ambiguous alias words.
  // "sofa table" / "console sofa" contain "sofa" but are console/cabinet furniture, not sofas.
  // "table decor" contains "table" but is a decorative piece, not a table.
  if (text.includes("sofa table") || text.includes("console sofa")) return "cabinet";
  if (text.includes("table decor")) return "decor";
  // Storage pieces with shelves are cabinets even if DB category is "side_table".
  // "table" is matched before "cabinet" in CATEGORY_ALIASES iteration; this pre-check
  // prevents storage cabinets mislabeled as side_table from filling the table slot.
  if (
    text.includes("cabinet") &&
    (text.includes("shelf") || text.includes("shelves") || text.includes("storage"))
  ) return "cabinet";
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if ([category, ...aliases].some((term) => text.includes(term))) return category;
  }
  return normalizeText(item?.normalized_category || item?.category || "decor") || "decor";
}

function buildAuthoritativeSelection(items: any[], requestedCategories: string[], roomType: string) {
  const slots = SLOT_PLANS[roomType] || requestedCategories;
  const usedHandles = new Set<string>();
  const selection: any[] = [];

  for (const slotCategory of slots) {
    const candidate = items.find((item) => {
      const handle = String(item?.product_handle || "");
      return handle && !usedHandles.has(handle) && inferPrimaryCategory(item) === slotCategory;
    });
    if (!candidate) continue;
    usedHandles.add(candidate.product_handle);
    selection.push({
      ...candidate,
      requestedCategory: slotCategory,
      confidence: Math.max(0.55, Math.min(0.99, Number(candidate._score || 0) / 10 + 0.55)),
    });
  }

  // Fill remaining slots from the pool, but never add a second item of the same
  // primary category as one already in the selection. This prevents a second sofa
  // from filling the wall_art slot when wall_art images are intermittently unreachable.
  const filledCategories = new Set(selection.map((s) => inferPrimaryCategory(s)));
  for (const item of items) {
    const handle = String(item?.product_handle || "");
    if (!handle || usedHandles.has(handle)) continue;
    const cat = inferPrimaryCategory(item);
    if (filledCategories.has(cat)) continue;
    usedHandles.add(handle);
    filledCategories.add(cat);
    selection.push({
      ...item,
      requestedCategory: cat,
      confidence: Math.max(0.45, Math.min(0.95, Number(item._score || 0) / 10 + 0.45)),
    });
    if (selection.length >= 7) break;
  }

  return selection.slice(0, 7);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const roomType = String(body?.roomType || "").trim();
    const theme = String(body?.theme || "").trim();
    const pageSize = Math.max(12, Math.min(18, Number(body?.pageSize || 12)));
    const seenHandles = Array.isArray(body?.seenHandles) ? body.seenHandles : [];
    const rotationCursor = Number(body?.rotationCursor || 0);
    const minPrice = typeof body?.minPrice === "number" ? body.minPrice : null;
    const maxPrice = typeof body?.maxPrice === "number" ? body.maxPrice : null;

    if (!roomType) return NextResponse.json({ error: "roomType is required" }, { status: 400 });
    if (!theme) return NextResponse.json({ error: "theme is required" }, { status: 400 });

    const requestedCategories = extractCategories(theme, roomType);

    // ── Living room: explicit per-slot retrieval (all themes) ─────────────────
    // Run 5 direct category-specific DB queries so each slot is guaranteed to
    // surface the right product type regardless of what the general pool returns.
    // Each theme gets tailored embeddings (see retrieveLivingRoomSlots in retrieval.ts).
    if (roomType === "living_room") {
      const slots = await retrieveLivingRoomSlots({ theme, minPrice, maxPrice });

      // Flatten all candidates and probe images in parallel
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot === "coffee_table" ? "table" : slot }))
      );
      const reachability = await Promise.all(
        allCandidates.map((item: any) => isImageReachable(item.image_url))
      );

      // Pick first reachable product per slot for authoritativeSelection (theme-curated).
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        const normalizedSlot = slot === "coffee_table" ? "table" : slot;
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({
              ...product,
              normalized_category: normalizedSlot,
              requestedCategory: normalizedSlot,
              confidence: 0.9,
            });
            break; // one per slot
          }
        }
      }

      console.log(`Living room slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0,40)}"`).join(" | ")}`);

      // Shortlist = full living room catalogue (no theme bias) so the user can browse
      // and swap any product freely. Theme is intentionally neutralised here.
      const generalResult = await retrieveCatalogue({
        roomType,
        theme: "living room furniture sofa chair rug table lamp",
        seenHandles,
        rotationCursor,
        pageSize,
        minPrice,
        maxPrice,
      });
      const shortlist = (generalResult?.shortlist || [])
        .filter(hasImage)
        .map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));

      return NextResponse.json({
        roomType,
        theme,
        requestedCategories,
        shortlist,
        authoritativeSelection,
        nextRotationCursor: generalResult?.nextRotationCursor ?? 0,
      });
    }

    // ── Kitchen: explicit per-slot retrieval (stool, lamp, decor) ────────────
    if (roomType === "kitchen") {
      const slots = await retrieveKitchenSlots({ theme, minPrice, maxPrice });

      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(
        allCandidates.map((item: any) => isImageReachable(item.image_url))
      );

      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({
              ...product,
              normalized_category: slot,
              requestedCategory: slot,
              confidence: 0.9,
            });
            break; // one per slot
          }
        }
      }

      console.log(`Kitchen slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0,40)}"`).join(" | ")} (stool=island seating, chair=dining area)`);

      // Shortlist = full kitchen catalogue (no theme bias) for user browsing
      const generalResult = await retrieveCatalogue({
        roomType,
        theme: "kitchen bar stool pendant light counter decor",
        seenHandles,
        rotationCursor,
        pageSize,
        minPrice,
        maxPrice,
      });
      const shortlist = (generalResult?.shortlist || [])
        .filter(hasImage)
        .map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));

      return NextResponse.json({
        roomType,
        theme,
        requestedCategories,
        shortlist,
        authoritativeSelection,
        nextRotationCursor: generalResult?.nextRotationCursor ?? 0,
      });
    }

    // ── Bedroom: explicit per-slot retrieval (bed, nightstand, lamp, bedding, dresser) ──
    if (roomType === "bedroom") {
      const slots = await retrieveBedroomSlots({ theme, minPrice, maxPrice });

      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(
        allCandidates.map((item: any) => isImageReachable(item.image_url))
      );

      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({
              ...product,
              normalized_category: slot,
              requestedCategory: slot,
              confidence: 0.9,
            });
            break; // one per slot
          }
        }
      }

      console.log(`Bedroom slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);

      // Shortlist = full bedroom catalogue for user browsing
      const generalResult = await retrieveCatalogue({
        roomType,
        theme: "bedroom bed nightstand lamp dresser bedding",
        seenHandles,
        rotationCursor,
        pageSize,
        minPrice,
        maxPrice,
      });
      const shortlist = (generalResult?.shortlist || [])
        .filter(hasImage)
        .map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));

      return NextResponse.json({
        roomType,
        theme,
        requestedCategories,
        shortlist,
        authoritativeSelection,
        nextRotationCursor: generalResult?.nextRotationCursor ?? 0,
      });
    }

    // ── Kids Room: explicit per-slot retrieval (bed, lamp, rug, storage, decor) ──
    if (roomType === "kids_room") {
      const slots = await retrieveKidsRoomSlots({ theme, minPrice, maxPrice });

      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(
        allCandidates.map((item: any) => isImageReachable(item.image_url))
      );

      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({
              ...product,
              normalized_category: slot,
              requestedCategory: slot,
              confidence: 0.9,
            });
            break; // one per slot
          }
        }
      }

      console.log(`Kids Room slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);

      const generalResult = await retrieveCatalogue({
        roomType,
        theme: "kids room bed lamp rug storage decor",
        seenHandles,
        rotationCursor,
        pageSize,
        minPrice,
        maxPrice,
      });
      const shortlist = (generalResult?.shortlist || [])
        .filter(hasImage)
        .map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));

      return NextResponse.json({
        roomType,
        theme,
        requestedCategories,
        shortlist,
        authoritativeSelection,
        nextRotationCursor: generalResult?.nextRotationCursor ?? 0,
      });
    }

    // ── Hallway: explicit per-slot retrieval (console, mirror, lamp, rug, bench) ──
    if (roomType === "hallway") {
      const slots = await retrieveHallwaySlots({ theme, minPrice, maxPrice });
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(allCandidates.map((item: any) => isImageReachable(item.image_url)));
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({ ...product, normalized_category: slot, requestedCategory: slot, confidence: 0.9 });
            break;
          }
        }
      }
      console.log(`Hallway slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);
      const generalResult = await retrieveCatalogue({ roomType, theme: "hallway console mirror lamp rug bench", seenHandles, rotationCursor, pageSize, minPrice, maxPrice });
      const shortlist = (generalResult?.shortlist || []).filter(hasImage).map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));
      return NextResponse.json({ roomType, theme, requestedCategories, shortlist, authoritativeSelection, nextRotationCursor: generalResult?.nextRotationCursor ?? 0 });
    }

    // ── Foyer: explicit per-slot retrieval (table, lamp, wall_art, mirror, bench) ──
    if (roomType === "foyer") {
      const slots = await retrieveFoyerSlots({ theme, minPrice, maxPrice });
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(allCandidates.map((item: any) => isImageReachable(item.image_url)));
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({ ...product, normalized_category: slot, requestedCategory: slot, confidence: 0.9 });
            break;
          }
        }
      }
      console.log(`Foyer slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);
      const generalResult = await retrieveCatalogue({ roomType, theme: "foyer entryway console lamp wall art mirror bench", seenHandles, rotationCursor, pageSize, minPrice, maxPrice });
      const shortlist = (generalResult?.shortlist || []).filter(hasImage).map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));
      return NextResponse.json({ roomType, theme, requestedCategories, shortlist, authoritativeSelection, nextRotationCursor: generalResult?.nextRotationCursor ?? 0 });
    }

    // ── Loft: explicit per-slot retrieval (table, lamp, wall_art, mirror, bench) ──
    if (roomType === "loft") {
      const slots = await retrieveLoftSlots({ theme, minPrice, maxPrice });
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(allCandidates.map((item: any) => isImageReachable(item.image_url)));
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({ ...product, normalized_category: slot, requestedCategory: slot, confidence: 0.9 });
            break;
          }
        }
      }
      console.log(`Loft slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);
      const generalResult = await retrieveCatalogue({ roomType, theme: "loft mezzanine console lamp wall art mirror bench", seenHandles, rotationCursor, pageSize, minPrice, maxPrice });
      const shortlist = (generalResult?.shortlist || []).filter(hasImage).map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));
      return NextResponse.json({ roomType, theme, requestedCategories, shortlist, authoritativeSelection, nextRotationCursor: generalResult?.nextRotationCursor ?? 0 });
    }

    // ── Frontyard: explicit per-slot retrieval (seating, table, lighting, planter) ──
    if (roomType === "frontyard") {
      const slots = await retrieveFrontyardSlots({ theme, minPrice, maxPrice });
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(allCandidates.map((item: any) => isImageReachable(item.image_url)));
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({ ...product, normalized_category: slot, requestedCategory: slot, confidence: 0.9 });
            break;
          }
        }
      }
      console.log(`Frontyard slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);
      const generalResult = await retrieveCatalogue({ roomType, theme: "outdoor porch garden seating table planter lighting", seenHandles, rotationCursor, pageSize, minPrice, maxPrice });
      const shortlist = (generalResult?.shortlist || []).filter(hasImage).map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));
      return NextResponse.json({ roomType, theme, requestedCategories, shortlist, authoritativeSelection, nextRotationCursor: generalResult?.nextRotationCursor ?? 0 });
    }

    // ── Backyard: explicit per-slot retrieval (seating, table, lighting, planter, fire_pit) ──
    if (roomType === "backyard") {
      const slots = await retrieveBackyardSlots({ theme, minPrice, maxPrice });
      const allCandidates = slots.flatMap(({ slot, products }) =>
        products.map((p: any) => ({ ...p, _slot: slot, normalized_category: slot }))
      );
      const reachability = await Promise.all(allCandidates.map((item: any) => isImageReachable(item.image_url)));
      const authoritativeSelection: any[] = [];
      for (const { slot, products } of slots) {
        for (const product of products) {
          const idx = allCandidates.findIndex(c => c.product_handle === product.product_handle);
          if (idx !== -1 && reachability[idx]) {
            authoritativeSelection.push({ ...product, normalized_category: slot, requestedCategory: slot, confidence: 0.9 });
            break;
          }
        }
      }
      console.log(`Backyard slots [${theme}]: ${authoritativeSelection.map(p => `${p.requestedCategory}="${p.title?.slice(0, 40)}"`).join(" | ")}`);
      const generalResult = await retrieveCatalogue({ roomType, theme: "outdoor patio garden sofa dining table planter fire pit lighting", seenHandles, rotationCursor, pageSize, minPrice, maxPrice });
      const shortlist = (generalResult?.shortlist || []).filter(hasImage).map((p: any) => ({ ...p, normalized_category: inferPrimaryCategory(p) }));
      return NextResponse.json({ roomType, theme, requestedCategories, shortlist, authoritativeSelection, nextRotationCursor: generalResult?.nextRotationCursor ?? 0 });
    }

    // ── General retrieval (all other rooms) ──────────────────────────────────
    const expandedTheme = normalizeText([theme, ...requestedCategories].join(" "));

    const result = await retrieveCatalogue({
      roomType,
      theme: expandedTheme,
      seenHandles,
      rotationCursor,
      pageSize,
      minPrice,
      maxPrice,
    });

    // Annotate all candidates with scores — retrieval returns 3× pageSize candidates
    // so each bucket has backup items in case some images are unreachable.
    const annotated = (result?.shortlist || [])
      .filter(hasImage)
      .map((item: any) => ({
        ...item,
        // Always infer from title — DB category is unreliable (e.g. side tables tagged as "decor")
        normalized_category: inferPrimaryCategory(item),
        _score: scoreItem(item, requestedCategories, roomType, theme),
      }));

    // Probe all images in parallel
    const reachability = await Promise.all(
      annotated.map((item: any) => isImageReachable(item.image_url))
    );
    const reachable = annotated.filter((_: any, idx: number) => reachability[idx]);

    // Group reachable items by bucket, sorted by score within each bucket.
    // This preserves bucket diversity while picking the best-scoring reachable
    // item per bucket (wrong-room items get -50 penalty and fall to the bottom).
    const byBucket = new Map<string, any[]>();
    for (const item of reachable) {
      const b = String(item.bucket || "other");
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(item);
    }
    for (const items of byBucket.values()) {
      items.sort((a: any, b: any) => Number(b._score || 0) - Number(a._score || 0));
    }
    // Interleave one item per bucket per round, in retrieval bucket order
    const bucketOrder = [...new Set(annotated.map((i: any) => String(i.bucket || "other")))];
    const queues = new Map(bucketOrder.map((b) => [b, [...(byBucket.get(b) ?? [])]]));
    const shortlist: any[] = [];
    let keepGoing = true;
    while (keepGoing && shortlist.length < pageSize) {
      keepGoing = false;
      for (const b of bucketOrder) {
        const q = queues.get(b)!;
        if (q.length > 0) {
          shortlist.push(q.shift()!);
          keepGoing = true;
          if (shortlist.length >= pageSize) break;
        }
      }
    }

    // Sort the full reachable pool by score so buildAuthoritativeSelection can find
    // the best item per slot across ALL candidates, not just the 12-item interleaved shortlist.
    const sortedForSelection = [...reachable].sort(
      (a: any, b: any) => Number(b._score || 0) - Number(a._score || 0)
    );
    const authoritativeSelection = buildAuthoritativeSelection(sortedForSelection, requestedCategories, roomType);

    return NextResponse.json({
      ...result,
      theme,
      requestedCategories,
      shortlist,
      authoritativeSelection,
    });
  } catch (error) {
    console.error("retrieve-catalogue error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to retrieve catalogue" },
      { status: 500 }
    );
  }
}

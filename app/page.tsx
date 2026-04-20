"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RoomType = "living_room" | "bedroom" | "dining_room" | "kitchen" | "office" | "foyer" | "loft" | "hallway" | "frontyard" | "backyard" | "kids_room";
type Product = {
  product_handle: string;
  title: string;
  category?: string | null;
  normalized_category?: string | null;
  image_url?: string | null;
  min_price?: number | null;
  max_price?: number | null;
  score?: number | null;
  requestedCategory?: string | null;
  style_tags?: string[];
};

type ValidationProduct = {
  title: string;
  category: string;
  similarityScore: number;
  presentInFinal: boolean;
  notes?: string;
};

// NEW: crop from the generated image showing where the invented item appeared
type InventedItemCrop = {
  name: string;
  imageUrl: string;
};

type ValidationReport = {
  accepted: boolean;
  geometryScore: number;
  catalogueAverageScore: number;
  hallucinationDetected: boolean;
  inventedItems: string[];
  notes: string[];
  products: ValidationProduct[];
  attemptsUsed?: number;
};

type PlacedProduct = {
  title: string;
  category: string;
  imageUrl: string;
  similarityScore?: number;
};

type Stage = "idle" | "detecting" | "retrieving" | "inspiring" | "inspire_review" | "generating" | "ready" | "done" | "error";

const ALL_THEMES = [
  { id: "scandi", label: "Scandi" },
  { id: "japandi", label: "Japandi" },
  { id: "coastal", label: "Coastal" },
  { id: "luxury", label: "Luxury" },
  { id: "industrial", label: "Industrial" },
  { id: "bohemian", label: "Boho" },
  { id: "mid_century", label: "Mid-Century" },
  { id: "modern", label: "Modern" },
];

// Themes supported per room type. Rooms not listed here default to ALL_THEMES.
const ROOM_THEMES: Partial<Record<RoomType, string[]>> = {
  kitchen:   ["modern", "industrial", "luxury", "bohemian", "mid_century"],
  bedroom:   ["scandi", "japandi", "coastal", "luxury", "bohemian", "mid_century", "modern"],
  kids_room: ["scandi", "coastal", "bohemian", "modern"],
  hallway:   ["scandi", "japandi", "coastal", "luxury", "mid_century", "modern"],
  foyer:     ["scandi", "japandi", "coastal", "luxury", "industrial", "bohemian", "mid_century", "modern"],
  loft:      ["scandi", "japandi", "coastal", "luxury", "industrial", "mid_century", "modern"],
  frontyard: ["coastal", "bohemian", "luxury", "modern"],
  backyard:  ["coastal", "bohemian", "luxury", "modern"],
};

const ROOM_LABELS: Record<RoomType, string> = {
  living_room: "Living Room",
  bedroom: "Bedroom",
  dining_room: "Dining Room",
  kitchen: "Kitchen",
  office: "Office",
  foyer: "Foyer / Entryway",
  loft: "Loft / Mezzanine",
  hallway: "Hallway",
  frontyard: "Front Yard",
  backyard: "Back Yard",
  kids_room: "Kids Room",
};

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function hasValidImage(p: Product): boolean {
  return Boolean(p.image_url && p.image_url.trim().length > 0);
}

function formatPrice(min?: number | null, max?: number | null) {
  if (min == null && max == null) return "";
  if (min != null && max != null && min !== max)
    return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  return `$${(min ?? max ?? 0).toLocaleString()}`;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [stageMsg, setStageMsg] = useState("");
  const [error, setError] = useState("");
  const [validationRejected, setValidationRejected] = useState(false);

  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState("image/jpeg");
  const [detectedRoom, setDetectedRoom] = useState<RoomType | null>(null);
  const [roomType, setRoomType] = useState<RoomType | null>(null);

  const [theme, setTheme] = useState("japandi");
  const [customTheme, setCustomTheme] = useState("");
  const [budgetMin, setBudgetMin] = useState<string>("");
  const [budgetMax, setBudgetMax] = useState<string>("");

  const [products, setProducts] = useState<Product[]>([]);
  // pages: Map of pageNumber (1-based) → product list for that page
  const [morePages, setMorePages] = useState<Map<number, Product[]>>(new Map());
  const [currentMorePage, setCurrentMorePage] = useState<number | null>(null);
  const [totalMorePages, setTotalMorePages] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rotationCursor, setRotationCursor] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // Slot-grouped product options returned by catalogue API (per-slot candidates for Path B)
  const [slotOptions, setSlotOptions] = useState<Array<{ slot: string; products: Product[] }>>([]);
  // Per-slot selection: maps slot name → selected product_handle
  const [slotSelections, setSlotSelections] = useState<Record<string, string>>({});

  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [inspiredImage, setInspiredImage] = useState<string | null>(null); // AI Design preview (pause-after-inspire)
  const [placedProducts, setPlacedProducts] = useState<PlacedProduct[]>([]);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [inventedItemCrops, setInventedItemCrops] = useState<InventedItemCrop[]>([]);

  // Generation / edit timer
  const [genElapsed, setGenElapsed] = useState<number | null>(null);
  const [timerMode, setTimerMode] = useState<"generating" | "swapping" | "editing" | null>(null);
  const genStartRef = useRef<number | null>(null);

  // More Matches search
  const [moreSearch, setMoreSearch] = useState("");

  // Targeted edit state
  const [editInstruction, setEditInstruction] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [swappingHandle, setSwappingHandle] = useState<string | null>(null);
  // Edit history: stack of generated images so user can go back
  const [imageHistory, setImageHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const effectiveTheme = customTheme.trim() || theme;
  const effectiveRoom = roomType || detectedRoom;
  const busy = stage === "detecting" || stage === "retrieving" || stage === "inspiring" || stage === "generating";

  // Themes available for the current room (kitchen gets 5, everything else gets all 8)
  const activeThemes = useMemo(() => {
    const allowed = effectiveRoom ? ROOM_THEMES[effectiveRoom] : null;
    return allowed ? ALL_THEMES.filter((t) => allowed.includes(t.id)) : ALL_THEMES;
  }, [effectiveRoom]);

  // When the room changes, reset theme to the first supported one if the current
  // theme isn't available for the new room (e.g. "scandi" → kitchen → "modern")
  useEffect(() => {
    const allowed = effectiveRoom ? ROOM_THEMES[effectiveRoom] : null;
    if (allowed && !allowed.includes(theme)) {
      setTheme(allowed[0]);
    }
  }, [effectiveRoom]);

  // Auto-load the first "More Matches" page as soon as Pass 2 starts so the
  // data is ready (or pre-fetched) by the time generation completes.
  useEffect(() => {
    if ((stage === "inspire_review" || stage === "generating" || stage === "done") && currentMorePage === null && !loadingMore) {
      goToMorePage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // Timer — ticks every second while generating, swapping, or editing
  useEffect(() => {
    if (!timerMode) return;
    const interval = setInterval(() => {
      if (genStartRef.current !== null) {
        setGenElapsed(Math.floor((Date.now() - genStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [timerMode]);

  const selectedProducts = useMemo(
    () => products.filter((p) => selected.has(p.product_handle) && hasValidImage(p)),
    [products, selected]
  );

  // All products fetched across all More Matches pages
  const allMoreProducts = useMemo(
    () => [...morePages.values()].flat(),
    [morePages]
  );

  // Filtered results when user types in More Matches search box
  const moreSearchResults = useMemo(() => {
    const q = moreSearch.trim().toLowerCase();
    if (!q) return null;
    return allMoreProducts.filter((p) => {
      const text = `${p.title} ${p.category ?? ""} ${p.normalized_category ?? ""}`.toLowerCase();
      return text.includes(q);
    });
  }, [moreSearch, allMoreProducts]);

  // Push a new image onto the history stack (called after every edit/generation)
  const pushHistory = useCallback((img: string) => {
    setImageHistory((prev) => {
      const base = prev.slice(0, historyIndex + 1);
      const next = [...base, img];
      setHistoryIndex(next.length - 1);
      return next;
    });
    setGeneratedImage(img);
  }, [historyIndex]);

  const undoEdit = useCallback(() => {
    if (historyIndex <= 0) return;
    const prev = historyIndex - 1;
    setHistoryIndex(prev);
    setGeneratedImage(imageHistory[prev]);
  }, [historyIndex, imageHistory]);

  const redoEdit = useCallback(() => {
    if (historyIndex >= imageHistory.length - 1) return;
    const next = historyIndex + 1;
    setHistoryIndex(next);
    setGeneratedImage(imageHistory[next]);
  }, [historyIndex, imageHistory]);

  const applyTextEdit = useCallback(async () => {
    if (!generatedImage || !editInstruction.trim() || !effectiveRoom) return;
    setEditLoading(true);
    setEditError("");
    genStartRef.current = Date.now();
    setGenElapsed(0);
    setTimerMode("editing");
    try {
      const res = await fetch("/api/targeted-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generatedImage,
          editInstruction: editInstruction.trim(),
          roomType: effectiveRoom,
          theme: effectiveTheme,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Edit failed");
      pushHistory(data.generatedImage);
      setEditInstruction("");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Edit failed");
    } finally {
      setEditLoading(false);
      setTimerMode(null);
    }
  }, [generatedImage, editInstruction, effectiveRoom, effectiveTheme, pushHistory]);

  const tryInRoom = useCallback(async (product: Product) => {
    if (!generatedImage || !effectiveRoom) return;
    setSwappingHandle(product.product_handle);
    setEditError("");
    genStartRef.current = Date.now();
    setGenElapsed(0);
    setTimerMode("swapping");
    try {
      const res = await fetch("/api/targeted-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generatedImage,
          product: {
            title: product.title,
            category: product.normalized_category || product.category || "furniture",
            imageUrl: product.image_url,
          },
          roomType: effectiveRoom,
          theme: effectiveTheme,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Swap failed");
      pushHistory(data.generatedImage);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Product swap failed");
    } finally {
      setSwappingHandle(null);
      setTimerMode(null);
    }
  }, [generatedImage, effectiveRoom, effectiveTheme, pushHistory]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const dataUri = await fileToDataUri(file);
    setOriginalImage(dataUri);
    setMimeType(file.type || "image/jpeg");
    setGeneratedImage(null);
    setPlacedProducts([]);
    setValidation(null);
    setInventedItemCrops([]);
    setEditInstruction("");
    setEditError("");
    setImageHistory([]);
    setHistoryIndex(-1);
    setProducts([]);
    setMorePages(new Map());
    setCurrentMorePage(null);
    setTotalMorePages(0);
    setSelected(new Set());
    setRotationCursor(0);
    setDetectedRoom(null);
    setRoomType(null);
    setError("");
    setValidationRejected(false);
    setStage("detecting");
    setStageMsg("Detecting room type…");

    try {
      const res = await fetch("/api/detect-room-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUri, mimeType: file.type || "image/jpeg" }),
      });
      const data = await res.json();
      if (!data.ok || !data.roomType) throw new Error(data.error || "Could not detect room type.");
      setDetectedRoom(data.roomType as RoomType);
      setStage("ready");
      setStageMsg("");
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Room detection failed.");
      setStageMsg("");
    }
  }, []);

  // Retrieve catalogue products — called automatically after inspire approval.
  // Returns the products (for chaining) and also sets state.
  const retrieveCatalogue = useCallback(async (): Promise<Product[]> => {
    if (!effectiveRoom) return [];

    const minPrice = budgetMin ? parseFloat(budgetMin) : null;
    const maxPrice = budgetMax ? parseFloat(budgetMax) : null;

    try {
      const res = await fetch("/api/retrieve-catalogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomType: effectiveRoom,
          theme: effectiveTheme,
          pageSize: 12,
          rotationCursor: 0,
          ...(minPrice !== null && { minPrice }),
          ...(maxPrice !== null && { maxPrice }),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Catalogue retrieval failed.");
      const shortlist: Product[] = (data.authoritativeSelection || data.shortlist || [])
        .filter(hasValidImage)
        .slice(0, 12);
      const autoSelected = new Set<string>(shortlist.slice(0, 8).map((p: Product) => p.product_handle));
      setProducts(shortlist);
      setSelected(autoSelected);
      setRotationCursor(data.nextRotationCursor ?? 1);

      // Store slot-grouped options for Path B UI
      if (Array.isArray(data.slotOptions)) {
        setSlotOptions(data.slotOptions);
        // Default: select first product per slot
        const defaults: Record<string, string> = {};
        for (const { slot, products: slotProducts } of data.slotOptions) {
          if (slotProducts.length > 0) defaults[slot] = slotProducts[0].product_handle;
        }
        setSlotSelections(defaults);
      }

      return shortlist;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Catalogue retrieval failed.");
      return [];
    }
  }, [effectiveRoom, effectiveTheme, budgetMin, budgetMax]);

  // Fetch a specific "More Matches" page. Uses cached result if already fetched.
  const goToMorePage = useCallback(async (targetPage: number) => {
    if (!effectiveRoom || loadingMore) return;

    // Already cached — just switch to it
    if (morePages.has(targetPage)) {
      setCurrentMorePage(targetPage);
      return;
    }

    setLoadingMore(true);
    try {
      // seenHandles = initial products + all already-fetched more-pages
      const seenHandles = [
        ...products.map((p) => p.product_handle),
        ...[...morePages.values()].flat().map((p) => p.product_handle),
      ];
      const res = await fetch("/api/retrieve-catalogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomType: effectiveRoom,
          theme: effectiveTheme,
          pageSize: 12,
          rotationCursor,
          seenHandles,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to load more.");
      const incoming: Product[] = (data.shortlist || []).filter(hasValidImage).slice(0, 12);
      const existingHandles = new Set(seenHandles);
      const fresh = incoming.filter((p) => !existingHandles.has(p.product_handle));

      setMorePages((prev) => new Map(prev).set(targetPage, fresh));
      setCurrentMorePage(targetPage);
      setTotalMorePages((prev) => Math.max(prev, targetPage));
      setRotationCursor(data.nextRotationCursor ?? rotationCursor + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more products.");
    } finally {
      setLoadingMore(false);
    }
  }, [effectiveRoom, effectiveTheme, loadingMore, morePages, products, rotationCursor]);

  // ── Step 2: Generate AI Design (Inspire) — pauses for user approval ──────
  const generateInspire = useCallback(async () => {
    if (!originalImage || !effectiveRoom) return;

    setStage("inspiring");
    setStageMsg("Creating AI Design…");
    setError("");
    setGeneratedImage(null);
    setInspiredImage(null);
    setImageHistory([]);
    setHistoryIndex(-1);
    setEditInstruction("");
    setEditError("");
    setPlacedProducts([]);
    setValidation(null);
    setInventedItemCrops([]);
    setValidationRejected(false);
    genStartRef.current = Date.now();
    setGenElapsed(0);
    setTimerMode("generating");
    setMoreSearch("");

    try {
      const inspireRes = await fetch("/api/fal-inspire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalImage,
          roomType: effectiveRoom,
          theme: effectiveTheme,
        }),
      });
      const inspireData = await inspireRes.json();
      if (!inspireRes.ok || !inspireData.ok) throw new Error(inspireData.error || "AI Design failed");

      // Show AI Design and STOP — wait for user approval
      setInspiredImage(inspireData.inspiredImage);
      setGeneratedImage(inspireData.inspiredImage);
      setTimerMode(null);
      setStage("inspire_review");
      setStageMsg("");
    } catch (err) {
      setTimerMode(null);
      setStage("error");
      setError(err instanceof Error ? err.message : "AI Design failed.");
      setStageMsg("");
    }
  }, [effectiveRoom, effectiveTheme, originalImage]);

  // ── Step 3: Place products on the approved AI Design ────────────────────
  // productsToPlace: if provided, only these products are used (Path B — manual selection).
  // If omitted, all selectedProducts are used (Path A — auto).
  // Auto-fetches catalogue if not loaded yet.
  const placeProducts = useCallback(async (productsToPlace?: Product[]) => {
    if (!originalImage || !effectiveRoom) return;

    setStage("generating");
    setStageMsg("Retrieving products…");
    setError("");

    // Auto-fetch catalogue if not loaded yet (Path A — user clicked "Generate Design" directly)
    let productsForPlacement = productsToPlace;
    if (!productsForPlacement) {
      if (selectedProducts.length === 0) {
        const fetched = await retrieveCatalogue();
        if (fetched.length === 0) {
          setStage("inspire_review");
          setError("No products found for this room and theme.");
          return;
        }
        // Use top 8 from fetched products
        productsForPlacement = fetched.slice(0, 8);
      } else {
        productsForPlacement = selectedProducts;
      }
    }
    if (productsForPlacement.length === 0) return;

    setStageMsg("Placing your products…");
    setPlacedProducts([]);
    setValidation(null);
    setInventedItemCrops([]);
    setValidationRejected(false);
    genStartRef.current = Date.now();
    setGenElapsed(0);
    setTimerMode("generating");

    try {
      const res = await fetch("/api/fal-place-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalImage,
          styledBaseImage: inspiredImage,
          mimeType,
          theme: effectiveTheme,
          roomType: effectiveRoom,
          products: productsForPlacement.slice(0, 8).map((p) => ({
            title: p.title,
            category: p.normalized_category || p.category || "furniture",
            imageUrl: p.image_url,
            productHandle: p.product_handle,
            styleTags: p.style_tags || [],
          })),
        }),
      });

      const data = await res.json();

      if (data.placedProducts) {
        setPlacedProducts(data.placedProducts);
      }
      if (data.validation) {
        setValidation(data.validation);
      }
      if (Array.isArray(data.inventedItemCrops)) {
        setInventedItemCrops(data.inventedItemCrops);
      }

      if (!data.ok) {
        if (data.generatedImage) {
          setImageHistory([data.generatedImage]);
          setHistoryIndex(0);
          setGeneratedImage(data.generatedImage);
        }
        setValidationRejected(true);
        setError(data.error || "Generation failed validation.");
        setStage("done");
      } else if (data.generatedImage) {
        setImageHistory([data.generatedImage]);
        setHistoryIndex(0);
        setGeneratedImage(data.generatedImage);
        setValidationRejected(false);
        setStage("done");
        setStageMsg("");
      }
      setTimerMode(null);
    } catch (err) {
      setTimerMode(null);
      setStage("error");
      setError(err instanceof Error ? err.message : "Product placement failed.");
      setStageMsg("");
    }
  }, [effectiveRoom, effectiveTheme, inspiredImage, mimeType, originalImage, selectedProducts]);

  function toggleProduct(handle: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else if (next.size < 8) next.add(handle);
      return next;
    });
  }

  // Collect crops keyed by invented item name for fast lookup
  const cropsByName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const crop of inventedItemCrops) {
      map[crop.name.toLowerCase()] = crop.imageUrl;
    }
    return map;
  }, [inventedItemCrops]);

  return (
    <div style={{ minHeight: "100vh", background: "#f5f6f8", color: "#111827", fontFamily: "Inter, Arial, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", background: "#111827", color: "white" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Interior AI</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            Depth-conditioned editing · Gemini validation · Hallucination detection
          </div>
        </div>
        <div style={{ fontSize: 13, opacity: 0.9, display: "flex", alignItems: "center", gap: 10 }}>
          {stageMsg || (stage === "done" ? (validationRejected ? "Best-effort shown (rejected)" : "Accepted") : "")}
          {timerMode && genElapsed !== null && (
            <span style={{ fontVariantNumeric: "tabular-nums", background: "rgba(255,255,255,0.15)", borderRadius: 6, padding: "2px 8px", fontSize: 12 }}>
              ⏱ {genElapsed}s
            </span>
          )}
          {!timerMode && genElapsed !== null && (
            <span style={{ fontVariantNumeric: "tabular-nums", background: "rgba(255,255,255,0.15)", borderRadius: 6, padding: "2px 8px", fontSize: 12 }}>
              ✓ {genElapsed}s
            </span>
          )}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 24, padding: 24 }}>
        {/* ── Left sidebar ─────────────────────────────────────────── */}
        <aside style={{ background: "white", borderRadius: 16, border: "1px solid #e5e7eb", padding: 18, alignSelf: "start" }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>1. Upload room</div>
          <div
            onClick={() => inputRef.current?.click()}
            style={{ border: "2px dashed #d1d5db", borderRadius: 12, padding: 18, cursor: "pointer", background: "#fafafa", textAlign: "center" }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>Click to upload room image</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>JPEG or PNG. Used as the geometry-locked base scene.</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />

          {effectiveRoom && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 12, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Detected room</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{ROOM_LABELS[effectiveRoom]}</div>
            </div>
          )}

          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 18, marginBottom: 10 }}>2. Theme</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {activeThemes.map((item) => {
              const active = !customTheme.trim() && theme === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => { setTheme(item.id); setCustomTheme(""); }}
                  style={{
                    borderRadius: 999,
                    border: active ? "1px solid #111827" : "1px solid #d1d5db",
                    background: active ? "#111827" : "white",
                    color: active ? "white" : "#111827",
                    padding: "8px 12px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <textarea
            value={customTheme}
            onChange={(e) => setCustomTheme(e.target.value)}
            rows={3}
            placeholder="Or type a custom theme, e.g. warm japandi with oak tones"
            style={{ width: "100%", marginTop: 10, borderRadius: 12, border: "1px solid #d1d5db", padding: 10, resize: "vertical" }}
          />

          {/* 3. Budget */}
          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 18, marginBottom: 10 }}>3. Budget (optional)</div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>Min ($)</label>
              <input
                type="number"
                value={budgetMin}
                onChange={(e) => setBudgetMin(e.target.value)}
                placeholder="0"
                min="0"
                style={{
                  width: "100%", marginTop: 4, borderRadius: 10, border: "1px solid #d1d5db",
                  padding: "8px 10px", fontSize: 13,
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>Max ($)</label>
              <input
                type="number"
                value={budgetMax}
                onChange={(e) => setBudgetMax(e.target.value)}
                placeholder="No limit"
                min="0"
                style={{
                  width: "100%", marginTop: 4, borderRadius: 10, border: "1px solid #d1d5db",
                  padding: "8px 10px", fontSize: 13,
                }}
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              disabled={!originalImage || !effectiveRoom || busy}
              onClick={generateInspire}
              style={{
                width: "100%", borderRadius: 12, background: "#2563eb", color: "white", border: 0,
                padding: "14px 14px", fontWeight: 700, fontSize: 15,
                cursor: !originalImage || !effectiveRoom || busy ? "not-allowed" : "pointer",
                opacity: !originalImage || !effectiveRoom || busy ? 0.5 : 1,
              }}
            >
              Generate AI Design
            </button>
          </div>

          {/* Error / warning banner */}
          {error && (
            <div style={{
              marginTop: 16, padding: 12, borderRadius: 12,
              background: validationRejected ? "#fffbeb" : "#fef2f2",
              border: `1px solid ${validationRejected ? "#fcd34d" : "#fecaca"}`,
              color: validationRejected ? "#92400e" : "#991b1b",
              fontSize: 13,
            }}>
              {validationRejected ? "Best-effort shown — " : ""}{error}
            </div>
          )}

          {/* Slot-grouped product selection moved to center panel */}
        </aside>

        {/* ── Right main content ──────────────────────────────────────── */}
        <main style={{ display: "grid", gap: 18 }}>
          {/* Original + Generated side by side */}
          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div style={{ background: "white", borderRadius: 16, border: "1px solid #e5e7eb", padding: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Original room</div>
              {originalImage ? (
                <img src={originalImage} alt="Original room" style={{ width: "100%", borderRadius: 12, display: "block" }} />
              ) : (
                <div style={{ minHeight: 360, borderRadius: 12, background: "#f9fafb", display: "grid", placeItems: "center", color: "#6b7280" }}>
                  Upload a room image to begin.
                </div>
              )}
            </div>

            <div style={{ background: "white", borderRadius: 16, border: "1px solid #e5e7eb", padding: 14 }}>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {stage === "inspiring" ? "Creating AI Design…"
                    : stage === "inspire_review" ? "AI Design Preview"
                    : stage === "generating" ? "Placing products…"
                    : "Generated room"}
                </div>
                {stage === "inspire_review" && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                    background: "#dbeafe", color: "#1d4ed8",
                  }}>
                    REVIEW
                  </span>
                )}
                {validation && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                    background: validation.accepted ? "#dcfce7" : "#fef9c3",
                    color: validation.accepted ? "#166534" : "#854d0e",
                  }}>
                    {validation.accepted ? "ACCEPTED" : "BEST EFFORT"}
                  </span>
                )}
                {/* Undo / redo — only visible once history has more than 1 entry */}
                {imageHistory.length > 1 && (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      onClick={undoEdit}
                      disabled={historyIndex <= 0}
                      title="Undo edit"
                      style={{
                        border: "1px solid #e5e7eb", borderRadius: 8, background: "white",
                        padding: "4px 10px", fontSize: 12, fontWeight: 600,
                        cursor: historyIndex <= 0 ? "not-allowed" : "pointer",
                        opacity: historyIndex <= 0 ? 0.4 : 1,
                      }}
                    >
                      ← Undo
                    </button>
                    <button
                      onClick={redoEdit}
                      disabled={historyIndex >= imageHistory.length - 1}
                      title="Redo edit"
                      style={{
                        border: "1px solid #e5e7eb", borderRadius: 8, background: "white",
                        padding: "4px 10px", fontSize: 12, fontWeight: 600,
                        cursor: historyIndex >= imageHistory.length - 1 ? "not-allowed" : "pointer",
                        opacity: historyIndex >= imageHistory.length - 1 ? 0.4 : 1,
                      }}
                    >
                      Redo →
                    </button>
                  </div>
                )}
              </div>

              {generatedImage ? (
                <img src={generatedImage} alt="Generated room" style={{ width: "100%", borderRadius: 12, display: "block" }} />
              ) : (
                <div style={{ minHeight: 360, borderRadius: 12, background: "#f9fafb", display: "grid", placeItems: "center", color: "#6b7280" }}>
                  {stage === "inspiring" ? "Creating AI Design…" : stage === "generating" ? "Placing products…" : "Your AI Design will appear here."}
                </div>
              )}

              {/* ── AI Design Review: Approve / Regenerate + Path A / Path B ── */}
              {stage === "inspire_review" && generatedImage && (
                <div style={{ marginTop: 16 }}>
                  {/* Info banner */}
                  <div style={{
                    padding: "12px 16px", borderRadius: 10,
                    background: "#eff6ff", border: "1px solid #bfdbfe",
                    marginBottom: 14, fontSize: 13, color: "#1e40af", lineHeight: 1.5,
                  }}>
                    This is your <strong>AI Design preview</strong> — a styled vision of your room.
                    If you like the direction, choose how to furnish it with real products below.
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {/* Path A: Generate with all catalogue products */}
                    <button
                      onClick={() => placeProducts()}
                      disabled={selectedProducts.length === 0}
                      style={{
                        flex: 1, minWidth: 180, padding: "14px 20px", borderRadius: 12,
                        background: "#2563eb", color: "white", border: 0,
                        fontWeight: 700, fontSize: 14,
                        cursor: selectedProducts.length === 0 ? "not-allowed" : "pointer",
                        opacity: selectedProducts.length === 0 ? 0.5 : 1,
                      }}
                    >
                      Generate Design
                      <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
                        Auto-place all catalogue products
                      </div>
                    </button>

                    {/* Path B: Choose products manually — fetch catalogue then scroll */}
                    <button
                      onClick={async () => {
                        if (products.length === 0) {
                          setStageMsg("Loading products…");
                          await retrieveCatalogue();
                          setStageMsg("");
                        }
                        // Small delay so DOM renders the product list before scrolling
                        setTimeout(() => {
                          const el = document.getElementById("product-selection");
                          if (el) el.scrollIntoView({ behavior: "smooth" });
                        }, 100);
                      }}
                      style={{
                        flex: 1, minWidth: 180, padding: "14px 20px", borderRadius: 12,
                        background: "white", color: "#374151", border: "2px solid #e5e7eb",
                        fontWeight: 700, fontSize: 14, cursor: "pointer",
                      }}
                    >
                      Choose Products
                      <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
                        Select specific items to place
                      </div>
                    </button>

                    {/* Regenerate */}
                    <button
                      onClick={generateInspire}
                      style={{
                        padding: "14px 20px", borderRadius: 12,
                        background: "white", color: "#6b7280", border: "1px solid #d1d5db",
                        fontWeight: 600, fontSize: 13, cursor: "pointer",
                      }}
                    >
                      Regenerate
                    </button>
                  </div>
                </div>
              )}

              {/* Targeted text edit — only shown after a room is generated */}
              {generatedImage && stage === "done" && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
                    Edit this room
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      value={editInstruction}
                      onChange={(e) => setEditInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !editLoading) applyTextEdit(); }}
                      placeholder='e.g. "change the sofa to a cozy velvet sofa"'
                      disabled={editLoading}
                      style={{
                        flex: 1, borderRadius: 10, border: "1px solid #d1d5db",
                        padding: "9px 12px", fontSize: 13,
                        opacity: editLoading ? 0.6 : 1,
                      }}
                    />
                    <button
                      onClick={applyTextEdit}
                      disabled={!editInstruction.trim() || editLoading}
                      style={{
                        borderRadius: 10, border: "none", background: "#111827",
                        color: "white", padding: "9px 16px", fontSize: 13, fontWeight: 700,
                        cursor: !editInstruction.trim() || editLoading ? "not-allowed" : "pointer",
                        opacity: !editInstruction.trim() || editLoading ? 0.5 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {editLoading ? "Editing…" : "Apply"}
                    </button>
                  </div>
                  {editError && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#991b1b" }}>{editError}</div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Validation gate */}
          {validation && (
            <section style={{ background: "white", borderRadius: 16, border: "1px solid #e5e7eb", padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>Validation gate</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    Geometry ≥ {72}% · Catalogue avg ≥ {50}% · Hallucination check
                  </div>
                </div>
                <div style={{
                  padding: "8px 14px", borderRadius: 999, fontWeight: 700, fontSize: 12,
                  background: validation.accepted ? "#dcfce7" : "#fef9c3",
                  color: validation.accepted ? "#166534" : "#854d0e",
                }}>
                  {validation.accepted
                    ? `ACCEPTED (${validation.attemptsUsed ?? 1} attempt${(validation.attemptsUsed ?? 1) > 1 ? "s" : ""})`
                    : `BEST EFFORT (all ${validation.attemptsUsed ?? 3} attempts rejected)`}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 16 }}>
                {[
                  { label: "Geometry", value: `${validation.geometryScore}%`, ok: validation.geometryScore >= 72 },
                  { label: "Catalogue avg", value: `${validation.catalogueAverageScore}%`, ok: validation.catalogueAverageScore >= 50 },
                  { label: "Hallucination", value: validation.hallucinationDetected ? "Flagged" : "Clear", ok: !validation.hallucinationDetected },
                  { label: "AI extras", value: String(validation.inventedItems.length), ok: validation.inventedItems.length === 0 },
                ].map((item) => (
                  <div key={item.label} style={{ borderRadius: 12, background: item.ok ? "#f0fdf4" : "#fef9c3", padding: 12, border: `1px solid ${item.ok ? "#bbf7d0" : "#fde68a"}` }}>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>{item.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: item.ok ? "#166534" : "#854d0e" }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {validation.notes.length > 0 && (
                <div style={{ marginTop: 14, fontSize: 13, color: "#374151" }}>
                  {validation.notes.map((note, idx) => (
                    <div key={idx} style={{ marginTop: idx === 0 ? 0 : 6 }}>• {note}</div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── SLOT-GROUPED PRODUCT SELECTION — center panel (Path B) ── */}
          {slotOptions.length > 0 && (stage === "inspire_review" || stage === "generating" || stage === "done") && (
            <section id="product-selection" style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                    Choose Your Products
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Pick one item per category to furnish your room
                  </div>
                </div>
                {stage === "inspire_review" && Object.keys(slotSelections).length > 0 && (
                  <button
                    onClick={() => {
                      const chosenProducts: Product[] = [];
                      for (const { slot, products: slotProds } of slotOptions) {
                        const handle = slotSelections[slot];
                        if (handle) {
                          const found = slotProds.find(p => p.product_handle === handle);
                          if (found) chosenProducts.push(found);
                        }
                      }
                      if (chosenProducts.length > 0) placeProducts(chosenProducts);
                    }}
                    style={{
                      padding: "10px 24px", borderRadius: 12,
                      background: "#2563eb", color: "white", border: 0,
                      fontWeight: 700, fontSize: 14, cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Generate with {Object.keys(slotSelections).length} product{Object.keys(slotSelections).length !== 1 ? "s" : ""}
                  </button>
                )}
              </div>

              {slotOptions.map(({ slot, products: slotProducts }) => {
                const slotLabel = slot.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                const selectedHandle = slotSelections[slot];
                return (
                  <div key={slot} style={{ marginBottom: 20 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 700, textTransform: "uppercase",
                      letterSpacing: "0.04em", color: "#374151", marginBottom: 10,
                      borderBottom: "1px solid #f3f4f6", paddingBottom: 6,
                    }}>
                      {slotLabel}
                    </div>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                      gap: 10,
                    }}>
                      {slotProducts.map((product) => {
                        const active = product.product_handle === selectedHandle;
                        return (
                          <button
                            key={product.product_handle}
                            onClick={() => {
                              setSlotSelections(prev => ({ ...prev, [slot]: product.product_handle }));
                            }}
                            style={{
                              borderRadius: 12,
                              border: active ? "2px solid #2563eb" : "1px solid #e5e7eb",
                              background: active ? "#eff6ff" : "white",
                              padding: 10, cursor: "pointer", textAlign: "center",
                              transition: "border-color 0.15s, background 0.15s",
                              position: "relative",
                            }}
                          >
                            {active && (
                              <div style={{
                                position: "absolute", top: 6, right: 6,
                                width: 20, height: 20, borderRadius: "50%",
                                background: "#2563eb", color: "white",
                                display: "grid", placeItems: "center",
                                fontSize: 12, fontWeight: 700,
                              }}>
                                ✓
                              </div>
                            )}
                            <img
                              src={product.image_url || ""}
                              alt={product.title}
                              style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 8 }}
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                            <div style={{
                              fontSize: 12, fontWeight: 600, marginTop: 8,
                              lineHeight: 1.3, height: 32, overflow: "hidden",
                              color: "#111827",
                            }}>
                              {product.title?.slice(0, 45)}
                            </div>
                            <div style={{ fontSize: 12, color: "#2563eb", fontWeight: 700, marginTop: 4 }}>
                              {formatPrice(product.min_price, product.max_price)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Bottom generate button */}
              {stage === "inspire_review" && Object.keys(slotSelections).length > 0 && (
                <button
                  onClick={() => {
                    const chosenProducts: Product[] = [];
                    for (const { slot, products: slotProds } of slotOptions) {
                      const handle = slotSelections[slot];
                      if (handle) {
                        const found = slotProds.find(p => p.product_handle === handle);
                        if (found) chosenProducts.push(found);
                      }
                    }
                    if (chosenProducts.length > 0) placeProducts(chosenProducts);
                  }}
                  style={{
                    marginTop: 8, width: "100%", padding: "14px 20px", borderRadius: 12,
                    background: "#2563eb", color: "white", border: 0,
                    fontWeight: 700, fontSize: 15, cursor: "pointer",
                  }}
                >
                  Generate with {Object.keys(slotSelections).length} selected product{Object.keys(slotSelections).length !== 1 ? "s" : ""}
                </button>
              )}
            </section>
          )}

          {/* ── RECOMMENDED PRODUCTS — IN YOUR ROOM panel ──────────────
               Shows ONLY products confirmed present in the generated room
               AND belonging to the user's catalogue (placedProducts).
               selectedProducts that were not detected in the room are excluded. */}
          {placedProducts.length > 0 && stage === "done" && (
            <section style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px" }}>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                    Recommended Products
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Your catalogue products visible in the generated room
                  </div>
                </div>
                <button
                  onClick={() => { const el = document.getElementById("more-matches"); el?.scrollIntoView({ behavior: "smooth" }); goToMorePage(totalMorePages + 1); }}
                  disabled={busy || loadingMore}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    border: "1px solid #e5e7eb", borderRadius: 999,
                    background: "white", padding: "8px 18px",
                    fontSize: 13, fontWeight: 600,
                    cursor: busy || loadingMore ? "not-allowed" : "pointer",
                    opacity: busy || loadingMore ? 0.5 : 1,
                  }}
                >
                  {loadingMore ? "Loading…" : "+ More Matches"}
                </button>
              </div>

              {/* IN YOUR ROOM tab */}
              <div style={{ borderBottom: "1px solid #f3f4f6", marginBottom: 20 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "8px 16px", borderRadius: "999px 999px 0 0",
                  background: "#fef9e7", border: "1px solid #fde68a", borderBottom: "none",
                  fontSize: 12, fontWeight: 700, color: "#92400e",
                  position: "relative", bottom: -1,
                }}>
                  🏠 IN YOUR ROOM
                </span>
              </div>

              {/* Product grid — driven by placedProducts (confirmed in room from catalogue) */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 }}>
                {placedProducts.map((placed, idx) => {
                  // Cross-reference selectedProducts to get price for this placed item
                  const catalogueItem = selectedProducts.find(
                    (p) => p.title === placed.title ||
                           (p.normalized_category || p.category) === placed.category
                  );
                  const matchScore = Math.round(placed.similarityScore || 0);

                  return (
                    <div
                      key={`${placed.title}-${idx}`}
                      style={{
                        borderRadius: 16, border: "1px solid #f3f4f6",
                        overflow: "hidden", background: "#fff",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                      }}
                    >
                      {/* Catalogue product image with badges */}
                      <div style={{ position: "relative" }}>
                        <img
                          src={placed.imageUrl}
                          alt={placed.title}
                          style={{ width: "100%", height: 200, objectFit: "cover", display: "block" }}
                        />
                        {/* Always shown — every card in this panel is confirmed in room */}
                        <span style={{
                          position: "absolute", top: 12, left: 12,
                          background: "#f59e0b", color: "white",
                          fontSize: 11, fontWeight: 800,
                          padding: "4px 10px", borderRadius: 999,
                          letterSpacing: 0.5, textTransform: "uppercase",
                        }}>
                          In Room
                        </span>
                        <span style={{
                          position: "absolute", top: 12, right: 12,
                          background: matchScore >= 82 ? "#111827" : "#f59e0b",
                          color: "white", fontSize: 11, fontWeight: 700,
                          padding: "4px 10px", borderRadius: 999,
                        }}>
                          {matchScore}% match
                        </span>
                      </div>

                      {/* Card body */}
                      <div style={{ padding: "14px 16px" }}>
                        <div style={{
                          fontSize: 14, fontWeight: 700, lineHeight: 1.35,
                          display: "-webkit-box", WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {placed.title}
                        </div>
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: "#9ca3af",
                          textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6,
                        }}>
                          {placed.category}
                        </div>
                        {catalogueItem && (
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginTop: 6 }}>
                            {formatPrice(catalogueItem.min_price, catalogueItem.max_price)}
                          </div>
                        )}

                        {/* Save / Buy buttons */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
                          <button style={{
                            border: "1px solid #e5e7eb", borderRadius: 10,
                            background: "white", padding: "9px 0",
                            fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151",
                          }}>
                            🛒 Save
                          </button>
                          <button style={{
                            border: "none", borderRadius: 10,
                            background: "#111827", color: "white",
                            padding: "9px 0", fontSize: 13, fontWeight: 700, cursor: "pointer",
                          }}>
                            Buy
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── AI INVENTED panel ─────────────────────────────────────── */}
          {(validation?.inventedItems?.length ?? 0) > 0 && (
            <section style={{ background: "white", borderRadius: 20, border: "1px solid #fde68a", padding: "22px 24px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                    AI Invented Items
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    These were added by the AI — not from your catalogue
                  </div>
                </div>
                <span style={{
                  background: "#fef3c7", color: "#92400e",
                  fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 999,
                }}>
                  {validation!.inventedItems.length} item{validation!.inventedItems.length > 1 ? "s" : ""}
                </span>
              </div>

              <div style={{ borderBottom: "1px solid #f3f4f6", marginBottom: 20, marginTop: 14 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "8px 16px", borderRadius: "999px 999px 0 0",
                  background: "#fef3c7", border: "1px solid #fde68a", borderBottom: "none",
                  fontSize: 12, fontWeight: 700, color: "#92400e",
                  position: "relative", bottom: -1,
                }}>
                  ⚠️ NOT IN CATALOGUE
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
                {validation!.inventedItems.map((itemName, idx) => {
                  const cropUrl = cropsByName[itemName.toLowerCase()];
                  // Skip items with no usable crop image
                  if (!cropUrl) return null;
                  return (
                    <div
                      key={`${itemName}-${idx}`}
                      style={{
                        borderRadius: 16, border: "1px solid #fde68a",
                        overflow: "hidden", background: "#fffbeb",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                      }}
                    >
                      <div style={{ position: "relative" }}>
                        <img
                          src={cropUrl}
                          alt={`AI invented: ${itemName}`}
                          style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                        />
                        <span style={{
                          position: "absolute", top: 10, left: 10,
                          background: "#ef4444", color: "white",
                          fontSize: 10, fontWeight: 800,
                          padding: "3px 9px", borderRadius: 999,
                          textTransform: "uppercase", letterSpacing: 0.5,
                        }}>
                          AI Added
                        </span>
                      </div>
                      <div style={{ padding: "12px 14px" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#92400e" }}>{itemName}</div>
                        <div style={{ fontSize: 11, color: "#b45309", marginTop: 4 }}>Not in your catalogue</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{
                marginTop: 16, fontSize: 12, color: "#92400e",
                background: "#fef3c7", padding: "10px 14px", borderRadius: 10,
              }}>
                These items are flagged and visible here so you can identify gaps in your catalogue.
                The validator rejects outputs containing major furniture hallucinations.
              </div>
            </section>
          )}

          {/* ── MORE MATCHES panel ─────────────────────────────────────
               Paginated browse-only panel. Shown during generation so users
               can browse while waiting, and remains visible after done.
               Each page shows 12 fresh products for the same room × theme. */}
          {(stage === "inspire_review" || stage === "generating" || stage === "done") && (
            <section id="more-matches" style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, gap: 16, flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                      More Matches
                    </div>
                    {stage === "generating" && (
                      <span style={{
                        display: "flex", alignItems: "center", gap: 6,
                        background: "#eff6ff", border: "1px solid #bfdbfe",
                        borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 600, color: "#1d4ed8",
                      }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3b82f6", display: "inline-block" }} />
                        Placing products in room…
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Browse more {effectiveRoom ? ROOM_LABELS[effectiveRoom] : "room"} products for your {effectiveTheme} theme
                  </div>
                </div>
                {/* Search box */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
                  <input
                    type="text"
                    placeholder="Search products e.g. coffee table…"
                    value={moreSearch}
                    onChange={(e) => setMoreSearch(e.target.value)}
                    style={{
                      padding: "8px 12px", borderRadius: 10, border: "1px solid #d1d5db",
                      fontSize: 13, width: 260, outline: "none",
                    }}
                  />
                  {moreSearch && (
                    <button
                      onClick={() => setMoreSearch("")}
                      style={{ fontSize: 12, color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Search results */}
              {moreSearchResults !== null ? (
                <>
                  <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
                    {moreSearchResults.length === 0
                      ? `No results for "${moreSearch}" — try loading more pages below`
                      : `${moreSearchResults.length} result${moreSearchResults.length !== 1 ? "s" : ""} for "${moreSearch}"`}
                  </div>
                  {moreSearchResults.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 20 }}>
                      {moreSearchResults.map((product: Product, idx: number) => (
                        <div
                          key={`search-${product.product_handle}-${idx}`}
                          style={{
                            display: "flex", flexDirection: "column",
                            borderRadius: 14, overflow: "hidden",
                            border: "1px solid #e5e7eb", background: "white",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                          }}
                        >
                          <img
                            src={product.image_url || ""}
                            alt={product.title}
                            style={{ width: "100%", height: 160, objectFit: "cover", display: "block" }}
                            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                          />
                          <div style={{ padding: "10px 12px", flex: 1, display: "flex", flexDirection: "column" }}>
                            <div style={{
                              fontSize: 12, fontWeight: 700, lineHeight: 1.35,
                              display: "-webkit-box", WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical", overflow: "hidden",
                            }}>
                              {product.title}
                            </div>
                            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>
                              {product.normalized_category || product.category || "furniture"}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginTop: 4 }}>
                              {formatPrice(product.min_price, product.max_price)}
                            </div>
                            {generatedImage && stage === "done" && (
                              <button
                                onClick={() => tryInRoom(product)}
                                disabled={swappingHandle === product.product_handle || editLoading}
                                style={{
                                  marginTop: 8, width: "100%",
                                  borderRadius: 8, border: "1px solid #111827",
                                  background: swappingHandle === product.product_handle ? "#f3f4f6" : "#111827",
                                  color: swappingHandle === product.product_handle ? "#6b7280" : "white",
                                  padding: "7px 0", fontSize: 12, fontWeight: 700,
                                  cursor: swappingHandle === product.product_handle || editLoading ? "not-allowed" : "pointer",
                                }}
                              >
                                {swappingHandle === product.product_handle ? "Swapping…" : "Try in Room"}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : null}

              {/* Page tabs — hidden when searching */}
              {!moreSearch && (
              <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                {Array.from({ length: totalMorePages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => goToMorePage(page)}
                    disabled={loadingMore}
                    style={{
                      padding: "6px 16px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                      border: currentMorePage === page ? "none" : "1px solid #e5e7eb",
                      background: currentMorePage === page ? "#111827" : "white",
                      color: currentMorePage === page ? "white" : "#374151",
                      cursor: loadingMore ? "not-allowed" : "pointer",
                    }}
                  >
                    Page {page}
                  </button>
                ))}
                <button
                  onClick={() => goToMorePage(totalMorePages + 1)}
                  disabled={loadingMore}
                  style={{
                    padding: "6px 16px", borderRadius: 999, fontSize: 13, fontWeight: 600,
                    border: "1px dashed #d1d5db", background: "white", color: "#6b7280",
                    cursor: loadingMore ? "not-allowed" : "pointer",
                  }}
                >
                  {loadingMore ? "Loading…" : "+ Next Page"}
                </button>
              </div>
              )}

              {/* Product grid for current page — hidden when searching */}
              {!moreSearch && currentMorePage !== null && (morePages.get(currentMorePage) ?? []).length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                  {(morePages.get(currentMorePage) ?? []).map((product: Product, idx: number) => (
                    <div
                      key={`more-${product.product_handle}-${idx}`}
                      style={{
                        display: "flex", flexDirection: "column",
                        borderRadius: 14, overflow: "hidden",
                        border: "1px solid #e5e7eb", background: "white",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                      }}
                    >
                      <img
                        src={product.image_url || ""}
                        alt={product.title}
                        style={{ width: "100%", height: 160, objectFit: "cover", display: "block" }}
                      />
                      <div style={{ padding: "10px 12px", flex: 1, display: "flex", flexDirection: "column" }}>
                        <div style={{
                          fontSize: 12, fontWeight: 700, lineHeight: 1.35,
                          display: "-webkit-box", WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {product.title}
                        </div>
                        <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>
                          {product.normalized_category || product.category || "furniture"}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginTop: 4 }}>
                          {formatPrice(product.min_price, product.max_price)}
                        </div>
                        {/* Try in Room — only shown after generation */}
                        {generatedImage && stage === "done" && (
                          <button
                            onClick={() => tryInRoom(product)}
                            disabled={swappingHandle === product.product_handle || editLoading}
                            style={{
                              marginTop: 8, width: "100%",
                              borderRadius: 8, border: "1px solid #111827",
                              background: swappingHandle === product.product_handle ? "#f3f4f6" : "#111827",
                              color: swappingHandle === product.product_handle ? "#6b7280" : "white",
                              padding: "7px 0", fontSize: 12, fontWeight: 700,
                              cursor: swappingHandle === product.product_handle || editLoading ? "not-allowed" : "pointer",
                            }}
                          >
                            {swappingHandle === product.product_handle ? "Swapping…" : "Try in Room"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state before first page is loaded */}
              {!moreSearch && currentMorePage === null && !loadingMore && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>
                  Click &quot;+ Next Page&quot; to browse more products
                </div>
              )}

              {loadingMore && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "#6b7280", fontSize: 13 }}>
                  Loading products…
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

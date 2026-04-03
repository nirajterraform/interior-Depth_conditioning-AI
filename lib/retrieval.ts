import { db } from "@/lib/db";
import { embedQuery } from "@/lib/embeddings";
import { RetrievedProduct, RoomType } from "@/lib/types";

type BucketConfig = {
  bucket:
    | "seating"
    | "tables"
    | "lighting"
    | "wall_art"
    | "decor"
    | "storage"
    | "soft_furnishing"
    | "bed";
  limit: number;
  required: boolean;
  allowedCategories?: string[];
};

type RetrieveCatalogueParams = {
  roomType: RoomType;
  theme: string;
  seenHandles?: string[];
  rotationCursor?: number;
  pageSize?: number;
  minPrice?: number | null;
  maxPrice?: number | null;
};

type RetrievalResult = {
  roomType: RoomType;
  theme: string;
  shortlist: RetrievedProduct[];
  nextRotationCursor: number;
};

// Maps app room types to the room key stored in supported_rooms_json in the DB.
// loft/hallway products are tagged as "living_room" in the DB.
// frontyard/backyard products are tagged as "outdoor" in the DB.
// kids_room products are tagged as "bedroom" in the DB (normalizer has no kids_room tag).
const DB_ROOM_LOOKUP: Partial<Record<RoomType, string>> = {
  loft: "living_room",
  hallway: "living_room",
  frontyard: "outdoor",
  backyard: "outdoor",
  kids_room: "bedroom",
};

// Room types that are outdoor spaces — these skip indoor BUCKET_EXCLUDES
// (the SQL allowedCategories already restricts to outdoor products)
const OUTDOOR_ROOM_TYPES = new Set<RoomType>(["frontyard", "backyard"]);

const ROOM_BUCKETS: Record<RoomType, BucketConfig[]> = {
  living_room: [
    {
      bucket: "seating",
      limit: 8,
      required: true,
      allowedCategories: ["sofa", "accent_chair", "ottoman", "bench"],
    },
    {
      bucket: "tables",
      limit: 4,
      required: true,
      allowedCategories: ["coffee_table", "side_table"],
    },
    {
      bucket: "lighting",
      limit: 2,
      required: true,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 4,
      required: false,
      allowedCategories: [
        "framed_art",
        "canvas_art",
        "canvas_sign",
        "metal_sign",
        "map_art",
        "wall_hanging",
      ],
    },
    {
      bucket: "decor",
      limit: 4,
      required: false,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "storage",
      limit: 3,
      required: false,
      // sideboard is a dining room piece — excluded from living room
      allowedCategories: ["cabinet", "shelf", "tv_stand"],
    },
    {
      bucket: "soft_furnishing",
      limit: 3,
      required: false,
      allowedCategories: ["rug", "window_treatment"],
    },
  ],

  bedroom: [
    {
      bucket: "bed",
      limit: 4,
      required: true,
      allowedCategories: ["bed", "mattress"],
    },
    {
      bucket: "seating",
      limit: 3,
      required: false,
      allowedCategories: ["accent_chair", "bench", "ottoman"],
    },
    {
      bucket: "tables",
      limit: 4,
      required: true,
      // nightstand products have category="nightstand" in DB, not "side_table"
      allowedCategories: ["side_table", "nightstand"],
    },
    {
      bucket: "lighting",
      limit: 2,
      required: true,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 4,
      required: false,
      allowedCategories: ["framed_art", "canvas_art", "map_art", "wall_hanging", "nursery_art"],
    },
    {
      bucket: "decor",
      limit: 3,
      required: false,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "storage",
      limit: 4,
      required: false,
      allowedCategories: ["dresser", "shelf"],
    },
    {
      bucket: "soft_furnishing",
      limit: 5,
      required: false,
      allowedCategories: ["rug", "bedding", "window_treatment"],
    },
  ],

  dining_room: [
    {
      bucket: "tables",
      limit: 4,
      required: true,
      allowedCategories: ["dining_table"],
    },
    {
      bucket: "seating",
      limit: 6,
      required: true,
      allowedCategories: ["dining_chair", "bench"],
    },
    {
      bucket: "lighting",
      limit: 2,
      required: false,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 4,
      required: false,
      allowedCategories: [
        "framed_art",
        "canvas_art",
        "canvas_sign",
        "metal_sign",
        "map_art",
        "wall_hanging",
      ],
    },
    {
      bucket: "decor",
      limit: 3,
      required: false,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "storage",
      limit: 3,
      required: false,
      allowedCategories: ["sideboard", "cabinet", "shelf"],
    },
    {
      bucket: "soft_furnishing",
      limit: 2,
      required: false,
      allowedCategories: ["rug", "window_treatment"],
    },
  ],

  kitchen: [
    {
      bucket: "seating",
      limit: 3,
      required: false,
      allowedCategories: ["bar_stool"],
    },
    {
      bucket: "lighting",
      limit: 2,
      required: false,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 3,
      required: false,
      allowedCategories: ["canvas_sign", "metal_sign", "framed_art", "canvas_art"],
    },
    {
      bucket: "decor",
      limit: 4,
      required: true,
      allowedCategories: ["decor", "mirror", "artificial_plant", "kitchen"],
    },
    {
      bucket: "storage",
      limit: 6,
      required: false,
      allowedCategories: ["kitchen_storage", "cabinet", "shelf"],
    },
    {
      bucket: "soft_furnishing",
      limit: 2,
      required: false,
      allowedCategories: ["window_treatment"],
    },
  ],

  office: [
    {
      bucket: "seating",
      limit: 4,
      required: true,
      allowedCategories: ["office_chair", "accent_chair", "bench", "ottoman"],
    },
    {
      bucket: "tables",
      limit: 3,
      required: true,
      allowedCategories: ["desk", "side_table"],
    },
    {
      bucket: "lighting",
      limit: 2,
      required: true,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 4,
      required: false,
      allowedCategories: ["framed_art", "canvas_art", "canvas_sign", "map_art", "wall_hanging"],
    },
    {
      bucket: "decor",
      limit: 3,
      required: false,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "storage",
      limit: 4,
      required: false,
      allowedCategories: ["shelf", "cabinet"],
    },
    {
      bucket: "soft_furnishing",
      limit: 2,
      required: false,
      allowedCategories: ["rug", "window_treatment"],
    },
  ],

  // Loft = foyer / entryway nook / mezzanine / transitional open space
  // Key pieces: console/accent table, table lamp, wall art, mirror, decorative items, accent bench, rug
  loft: [
    {
      bucket: "tables",
      limit: 6,
      required: true,
      // console_table and side_table are the hero pieces for a foyer/loft
      allowedCategories: ["console_table", "side_table", "coffee_table"],
    },
    {
      bucket: "lighting",
      limit: 4,
      required: true,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 6,
      required: true,
      allowedCategories: ["framed_art", "canvas_art", "canvas_sign", "metal_sign", "map_art", "wall_hanging"],
    },
    {
      bucket: "decor",
      limit: 5,
      required: true,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "seating",
      limit: 2,
      required: false,
      // accent bench is common in foyers; no sofas
      allowedCategories: ["bench", "ottoman", "accent_chair"],
    },
    {
      bucket: "storage",
      limit: 3,
      required: false,
      allowedCategories: ["cabinet", "shelf"],
    },
    {
      bucket: "soft_furnishing",
      limit: 3,
      required: false,
      allowedCategories: ["rug", "window_treatment"],
    },
  ],

  // Hallway = long narrow corridor inside a home
  // Key pieces: wall art/mirrors (on walls), small console table, lamp, runner rug
  hallway: [
    {
      bucket: "wall_art",
      limit: 8,
      required: true,
      allowedCategories: ["framed_art", "canvas_art", "canvas_sign", "metal_sign", "map_art", "wall_hanging"],
    },
    {
      bucket: "decor",
      limit: 6,
      required: true,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "tables",
      limit: 4,
      required: false,
      allowedCategories: ["console_table", "side_table"],
    },
    {
      bucket: "lighting",
      limit: 3,
      required: false,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "soft_furnishing",
      limit: 3,
      required: false,
      allowedCategories: ["rug", "window_treatment"],
    },
    {
      bucket: "storage",
      limit: 2,
      required: false,
      allowedCategories: ["cabinet", "shelf"],
    },
  ],

  // Frontyard = outdoor space in front of the home
  // Key pieces: outdoor seating, planters, pathway lighting, decorative items
  frontyard: [
    {
      bucket: "seating",
      limit: 6,
      required: true,
      allowedCategories: ["outdoor_seating", "bench", "outdoor_chair", "outdoor_sofa"],
    },
    {
      bucket: "tables",
      limit: 4,
      required: false,
      allowedCategories: ["outdoor_table", "side_table"],
    },
    {
      bucket: "lighting",
      limit: 4,
      required: true,
      allowedCategories: ["outdoor_lighting", "lamp"],
    },
    {
      bucket: "decor",
      limit: 6,
      required: true,
      allowedCategories: ["outdoor_decor", "planter", "artificial_plant", "decor"],
    },
    {
      bucket: "soft_furnishing",
      limit: 3,
      required: false,
      allowedCategories: ["outdoor_rug", "rug"],
    },
  ],

  // Backyard = private outdoor space behind the home
  // Key pieces: outdoor dining sets, loungers, fire pits, planters, lighting
  backyard: [
    {
      bucket: "seating",
      limit: 8,
      required: true,
      allowedCategories: ["outdoor_seating", "outdoor_sofa", "outdoor_chair", "bench", "outdoor_lounger"],
    },
    {
      bucket: "tables",
      limit: 5,
      required: true,
      allowedCategories: ["outdoor_table", "outdoor_dining_table", "side_table"],
    },
    {
      bucket: "lighting",
      limit: 4,
      required: true,
      allowedCategories: ["outdoor_lighting", "lamp"],
    },
    {
      bucket: "decor",
      limit: 6,
      required: true,
      allowedCategories: ["outdoor_decor", "planter", "artificial_plant", "decor", "fire_pit"],
    },
    {
      bucket: "soft_furnishing",
      limit: 3,
      required: false,
      allowedCategories: ["outdoor_rug", "rug"],
    },
    {
      bucket: "storage",
      limit: 2,
      required: false,
      allowedCategories: ["outdoor_storage", "cabinet"],
    },
  ],

  // Kids room = children's bedroom or playroom
  // Key pieces: single/bunk bed, small accent chair, lamp, wall art (nursery/kids),
  // soft rug, storage (toy box, bookshelf), colourful decor
  kids_room: [
    {
      bucket: "bed",
      limit: 4,
      required: true,
      allowedCategories: ["bed", "mattress"],
    },
    {
      bucket: "seating",
      limit: 3,
      required: false,
      allowedCategories: ["accent_chair", "bench", "ottoman"],
    },
    {
      bucket: "tables",
      limit: 3,
      required: false,
      allowedCategories: ["side_table", "nightstand", "desk"],
    },
    {
      bucket: "lighting",
      limit: 3,
      required: true,
      allowedCategories: ["lamp"],
    },
    {
      bucket: "wall_art",
      limit: 5,
      required: true,
      allowedCategories: ["framed_art", "canvas_art", "canvas_sign", "wall_hanging", "nursery_art"],
    },
    {
      bucket: "decor",
      limit: 4,
      required: true,
      allowedCategories: ["decor", "mirror", "artificial_plant", "floral_arrangement"],
    },
    {
      bucket: "storage",
      limit: 4,
      required: false,
      allowedCategories: ["shelf", "cabinet"],
    },
    {
      bucket: "soft_furnishing",
      limit: 4,
      required: false,
      allowedCategories: ["rug", "bedding", "window_treatment"],
    },
  ],
};

const BUCKET_EXCLUDES: Record<string, string[]> = {
  seating: [
    "bedding",
    "bedsheet",
    "sheet",
    "quilt",
    "duvet",
    "comforter",
    "blanket",
    "pillow",
    "sham",
    "slipcover",
    "sofa cover",
    "sink",
    "faucet",
    "playhouse",
    // Exclude tables from seating — "sofa table" contains "sofa" but is not a sofa
    "sofa table",
    "console table",
    "entryway table",
    "side table",
    "end table",
    "drawers and shelves",
    // Exclude outdoor furniture — never belongs indoors
    "outdoor",
    "patio",
    "garden",
    "pool",
    "deck",
    "adirondack",
    "pergola",
    "gazebo",
    // Dining chairs belong in dining room, not living room seating bucket
    "dining chair",
    "dining chairs",
    "parson chair",
    "parson dining",
  ],
  tables: [
    "bedding",
    "quilt",
    "duvet",
    "comforter",
    "blanket",
    "sink",
    "faucet",
    "playhouse",
    "lamp shade",
    "painting",
    // Use multi-word phrases — bare "console" / "entryway" were blocking console tables
    // for loft/hallway; SQL allowedCategories already handles living room (coffee_table/side_table only)
    "console table",
    "entryway table",
    "sofa table",
    "accent sofa",
    "narrow sofa",
    // Exclude living room sets — multi-piece sets not actual tables
    "living room set",
    "furniture set",
    "sofa set",
    // Exclude bar/pub tables — too tall for living room use
    "bar table",
    "bar stool",
    "pub table",
    "bistro table",
    "bar height",
    "counter height",
    "pub height",
    // Books miscategorised as coffee_table in the DB
    "making fashion",
    "harpers bazaar",
    "pierre cardin",
    "items and interiors",
    // Sofas/recliners miscategorised as coffee_table
    "recliner sofa",
    "power recliner",
    "velvet sofa",
    "sectional sofa",
    // Stools/ottomans miscategorised as coffee_table — ottoman is seating not a table
    "ottoman coffee",
    "lift top ottoman",
    // Pet furniture — cat/dog beds disguised as "end table" or "cube lounge"
    "cat bed",
    "cat lounge",
    "cat cube",
    "cat tree",
    "dog bed",
    "pet bed",
    "pet furniture",
    // NOTE: nightstand entries removed — SQL allowedCategories now handles room-level
    // filtering at the source; bedroom.tables includes "nightstand" in allowedCategories
  ],
  lighting: [
    "bedding",
    "quilt",
    "duvet",
    "comforter",
    "sink",
    "faucet",
    "playhouse",
    "sofa set",
    "bedroom set",
    "dining set",
  ],
  wall_art: [
    "sink",
    "faucet",
    "playhouse",
    "bedding",
    "quilt",
    "duvet",
    "comforter",
    "pillow",
    "rug",
    // Use precise multi-word furniture phrases — bare words like "sofa", "bed", "table"
    // are too aggressive: art product titles routinely contain them as room context
    // e.g. "Modern Sofa Background Canvas", "Bedroom Abstract Wall Painting"
    "sofa set",
    "sectional sofa",
    "sofa couch",
    "tv stand",
    "tv console",
    "office chair",
    "dining table",
    "dining chair",
    "bar stool",
    "nightstand",
    "dresser",
    "wardrobe",
    "bed frame",
    "coffee table",
    "side table",
  ],
  decor: [
    "sink",
    "faucet",
    "playhouse",
    "mattress",
    // Exclude bathroom accessories — they slip into decor bucket
    "bathroom",
    "toilet",
    "shower",
    "bath mat",
    "towel",
    "towel ring",
    "towel bar",
    "towel rack",
    "soap dispenser",
    "toothbrush",
    // Dining chairs miscategorised as decor in DB — block them from appearing as decor
    "dining chair",
    "dining chairs",
    "parson chair",
    "parson dining",
  ],
  storage: [
    "sink",
    "faucet",
    "playhouse",
    "bedding",
    "quilt",
    "duvet",
    "comforter",
    "pillow",
    // Shoe-specific storage belongs in entryway/hallway, never in living room / bedroom / office
    "shoe cabinet",
    "shoe rack",
    "shoe storage",
    "shoe bench",
    "shoe organizer",
    "footwear",
    "entryway cabinet",
    "hallway cabinet",
    // Bathroom storage never belongs in any living space
    "bathroom cabinet",
    "medicine cabinet",
    "vanity cabinet",
    "bathroom vanity",
    "linen cabinet",
    "linen tower",
    // Office filing
    "file cabinet",
    "filing cabinet",
    "mobile file",
    "lateral file",
    "pedestal file",
    "office storage",
    // Bookcases belong in office/study — not living room
    "bookcase",
    "bookshelf",
    "book shelf",
    // Office desks — slip through storage bucket when title contains "cabinet"
    // e.g. "L Shape Executive Desk With Drawers And Cabinet"
    "executive desk",
    "l shape desk",
    "l-shape desk",
    "l shaped desk",
    "writing desk",
    "corner desk",
    "computer desk",
    "office desk",
    "workstation desk",
  ],
  soft_furnishing: [
    "sink", "faucet", "playhouse",
    // Exclude bathroom rugs/mats — they're in soft_furnishing bucket but not for living spaces
    "bathroom rug",
    "bath mat",
    "bath rug",
    "shower curtain",
  ],
  bed: ["sink", "faucet", "playhouse"],
};

const BUCKET_INCLUDES: Record<string, string[]> = {
  seating: ["sofa", "sectional", "modular sofa", "l shaped", "couch", "chair", "armchair", "accent chair", "bench", "ottoman"],
  tables: ["table", "desk", "side table", "coffee table"],
  lighting: ["lamp", "light", "chandelier", "sconce", "pendant"],
  wall_art: ["art", "canvas", "framed", "print", "poster", "map", "hanging", "sign"],
  decor: ["decor", "vase", "mirror", "plant", "flower", "arrangement", "tray", "candle"],
  storage: ["cabinet", "shelf", "bookcase", "tv stand", "sideboard", "dresser"],
  soft_furnishing: ["rug", "bedding", "curtain", "window", "runner"],
  bed: ["bed", "mattress", "headboard"],
};

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function containsAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    return regex.test(lower);
  });
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function seededNoise(seed: string, salt: string): number {
  const h = hashString(`${seed}:${salt}`);
  return (h % 1000) / 1000;
}

function rotateArray<T>(items: T[], offset: number): T[] {
  if (!items.length) return items;
  const n = offset % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

function rerankBucketItems(
  bucket: string,
  items: RetrievedProduct[],
  theme: string,
  diversificationSeed: string,
  roomType?: RoomType
): RetrievedProduct[] {
  const includes = BUCKET_INCLUDES[bucket] ?? [];
  // Outdoor rooms (frontyard/backyard) use outdoor products — skip indoor excludes
  const excludes = roomType && OUTDOOR_ROOM_TYPES.has(roomType) ? [] : (BUCKET_EXCLUDES[bucket] ?? []);
  const themeWords = theme
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 2);

  const filtered = items.filter((item) => {
    const text = `${item.title} ${item.category ?? ""} ${item.subcategory ?? ""} ${item.normalized_category ?? ""}`.toLowerCase();
    if (containsAny(text, excludes)) return false;
    return true;
  });

  const scored = filtered.map((item) => {
    const text = `${item.title} ${item.category ?? ""} ${item.subcategory ?? ""} ${item.normalized_category ?? ""}`.toLowerCase();

    let score = (item.similarity ?? 0) * 10;

    if (containsAny(text, includes)) score += 2.5;

    const overlap = themeWords.filter((w) => text.includes(w)).length;
    score += Math.min(overlap, 4) * 0.35;

    const jitter = seededNoise(diversificationSeed, item.product_handle) * 0.35;
    score += jitter;

    return { ...item, __score: score };
  });

  scored.sort((a, b) => b.__score - a.__score);

  const diversified: typeof scored = [];
  const seenTitleFamilies = new Set<string>();
  const seenHandles = new Set<string>();

  for (const item of scored) {
    const family = item.title.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
    if (seenHandles.has(item.product_handle)) continue;

    if (seenTitleFamilies.has(family) && diversified.length < Math.ceil(scored.length * 0.7)) {
      continue;
    }

    diversified.push(item);
    seenHandles.add(item.product_handle);
    seenTitleFamilies.add(family);
  }

  for (const item of scored) {
    if (!seenHandles.has(item.product_handle)) {
      diversified.push(item);
      seenHandles.add(item.product_handle);
    }
  }

  return diversified.map(({ __score, ...rest }) => rest);
}

async function queryBucketCandidates(
  embedding: number[],
  roomType: RoomType,
  bucket: BucketConfig,
  excludedHandles: string[],
  minPrice: number | null,
  maxPrice: number | null
): Promise<RetrievedProduct[]> {
  const vector = vectorLiteral(embedding);
  const candidateLimit = Math.max(bucket.limit * 8, 36);

  // loft/hallway map to "living_room" in DB; frontyard/backyard map to "outdoor"
  const dbRoom = DB_ROOM_LOOKUP[roomType] ?? roomType;
  const params: unknown[] = [vector, dbRoom, bucket.bucket, candidateLimit];
  let paramIndex = 5;

  const clauses: string[] = [
    `embedding IS NOT NULL`,
    `primary_image_url IS NOT NULL`,
    `supported_rooms_json ? $2`,
    `retrieval_bucket = $3`,
  ];

  if (bucket.allowedCategories && bucket.allowedCategories.length > 0) {
    clauses.push(`category = ANY($${paramIndex}::text[])`);
    params.push(bucket.allowedCategories);
    paramIndex += 1;
  }

  if (excludedHandles.length > 0) {
    clauses.push(`product_handle <> ALL($${paramIndex}::text[])`);
    params.push(excludedHandles);
    paramIndex += 1;
  }

  if (minPrice !== null) {
    clauses.push(`max_price >= $${paramIndex}`);
    params.push(minPrice);
    paramIndex += 1;
  }

  if (maxPrice !== null) {
    clauses.push(`min_price <= $${paramIndex}`);
    params.push(maxPrice);
    paramIndex += 1;
  }

  const sql = `
    SELECT
      product_handle,
      title,
      category,
      category AS subcategory,
      category AS normalized_category,
      primary_image_url,
      min_price,
      max_price,
      1 - (embedding <=> $1::vector) AS similarity
    FROM products
    WHERE ${clauses.join("\n      AND ")}
    ORDER BY embedding <=> $1::vector
    LIMIT $4
  `;

  const result = await db.query(sql, params);

  return result.rows
    .filter((row: any) => row.primary_image_url)
    .map((row: any) => ({
      bucket: bucket.bucket,
      product_handle: row.product_handle,
      title: row.title,
      category: row.category,
      subcategory: row.subcategory,
      normalized_category: row.normalized_category,
      image_url: row.primary_image_url,
      min_price: row.min_price !== null ? Number(row.min_price) : null,
      max_price: row.max_price !== null ? Number(row.max_price) : null,
      similarity: Number(row.similarity),
    }));
}

function buildDiversificationSeed(roomType: RoomType, theme: string): string {
  const minuteBucket = Math.floor(Date.now() / (1000 * 60));
  return `${roomType}|${theme.toLowerCase()}|${minuteBucket}`;
}

function interleaveByBucket(
  rotatedBuckets: BucketConfig[],
  bucketItemsMap: Record<string, RetrievedProduct[]>,
  pageSize: number
): RetrievedProduct[] {
  const result: RetrievedProduct[] = [];
  const bucketQueues: Record<string, RetrievedProduct[]> = {};

  for (const bucket of rotatedBuckets) {
    bucketQueues[bucket.bucket] = [...(bucketItemsMap[bucket.bucket] ?? [])];
  }

  while (result.length < pageSize) {
    let addedThisRound = false;

    for (const bucket of rotatedBuckets) {
      const queue = bucketQueues[bucket.bucket];
      if (queue && queue.length > 0) {
        result.push(queue.shift()!);
        addedThisRound = true;

        if (result.length >= pageSize) break;
      }
    }

    if (!addedThisRound) break;
  }

  return result;
}

export async function retrieveCatalogue(
  params: RetrieveCatalogueParams
): Promise<RetrievalResult> {
  const {
    roomType,
    theme,
    seenHandles = [],
    rotationCursor = 0,
    pageSize = 18,
    minPrice = null,
    maxPrice = null,
  } = params;

  const queryText = `${theme} for ${roomType.replaceAll("_", " ")}`;
  const embedding = await embedQuery(queryText);

  // Sectional-biased embedding only makes sense for living room where a large sofa is the hero.
  // For bedroom (bench/accent chair), office (task chair), loft/hallway/outdoor use generic embedding.
  const SOFA_ROOMS = new Set<RoomType>(["living_room"]);
  const SEATING_QUERY_SUFFIX = "large sectional sofa L shaped couch 3 seater";
  const seatingQueryText = SOFA_ROOMS.has(roomType)
    ? `${theme} ${SEATING_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : queryText;
  const seatingEmbedding = SOFA_ROOMS.has(roomType)
    ? await embedQuery(seatingQueryText)
    : embedding;

  const buckets = ROOM_BUCKETS[roomType];
  const diversificationSeed = buildDiversificationSeed(roomType, theme);

  const globalExcludedHandles = [...seenHandles];

  const bucketResults = await Promise.all(
    buckets.map(async (bucket) => {
      // Use sectional-biased embedding for sofa/seating bucket
      const bucketEmbedding = bucket.bucket === "seating" ? seatingEmbedding : embedding;
      const candidates = await queryBucketCandidates(
        bucketEmbedding,
        roomType,
        bucket,
        globalExcludedHandles,
        minPrice,
        maxPrice
      );

      const reranked = rerankBucketItems(
        bucket.bucket,
        candidates,
        theme,
        diversificationSeed,
        roomType
      );

      return { bucketName: bucket.bucket, reranked };
    })
  );

  const bucketResultsMap: Record<string, RetrievedProduct[]> = {};
  for (const { bucketName, reranked } of bucketResults) {
    bucketResultsMap[bucketName] = reranked;
  }

  const rotatedBuckets = rotateArray(
    buckets,
    rotationCursor % Math.max(1, buckets.length)
  );

  // Return 3× candidates so route.ts has backup items per bucket in case some
  // images are unreachable — route.ts will re-select within each bucket by score.
  const shortlist = interleaveByBucket(rotatedBuckets, bucketResultsMap, pageSize * 3);

  const nextRotationCursor =
    (rotationCursor + 1) % Math.max(1, buckets.length);

  return {
    roomType,
    theme,
    shortlist,
    nextRotationCursor,
  };
}

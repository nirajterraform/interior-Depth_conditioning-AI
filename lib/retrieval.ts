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
  foyer: "living_room",
  loft: "living_room",
  hallway: "living_room",
  frontyard: "outdoor",
  backyard: "outdoor",
  kids_room: "kids_room",
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
      // mirrors excluded — FLUX places them against walls and covers architectural features (fireplace, windows)
      allowedCategories: ["decor", "artificial_plant", "floral_arrangement"],
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

  // Foyer = front-door entryway nook
  // Key pieces: console/accent table, table lamp, wall art, mirror, decorative items, accent bench, rug
  foyer: [
    {
      bucket: "tables",
      limit: 6,
      required: true,
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

  // Loft = mezzanine / open staircase landing / architectural open space
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
    // Rattan/wicker sofas — titles often omit "outdoor"/"patio" but are patio sets
    // e.g. "Rattan Sofa Set 4 Piece" — these slip past the "outdoor"/"patio" filter
    "rattan sofa",
    "rattan couch",
    "rattan sectional",
    "wicker sofa",
    "wicker couch",
    "wicker sectional",
    // Swivel chairs are office/functional — not a living room statement piece
    "swivel chair",
    "swivel accent",
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
    // Lift-top / hidden compartment coffee tables are functional/transitional,
    // not a style-forward piece — exclude globally from aesthetic room design
    "lift top",
    "lift-top",
    "hidden compartment",
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
    // Non-floor-lamp fixture types — wall/ceiling/table-mounted, never a floor lamp
    // Note: word-boundary regex won't match "chandeliers" from "chandelier",
    // so both singular and plural must be listed explicitly.
    "chandelier",
    "chandeliers",
    "ceiling light",
    "ceiling lamp",
    "ceiling fan",
    "ceiling fans",
    "pendant light",
    "pendant lamp",
    "sconce",
    "wall lamp",
    "wall light",
    // Novelty/party lamps — high embedding similarity to "boho/modern" but wrong for home staging
    "polar star",
    "3d printed led",
    "galaxy projector",
    "star projector",
    "disco",
    "lava lamp",
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
    // Large freestanding furniture/utility pieces miscategorised as decor —
    // they win via style tag +8 bonus despite not being counter/table-top decor
    "plant stand",
    "plant stands",
    "hanging hooks",
    "bakers rack",
    "baker's rack",
    "shoe rack",
    "shoe racks",
    "coat rack",
    "coat stand",
    "hat rack",
    "clothing rack",
    "garment rack",
    "wine rack",
    "magazine rack",
    "ladder shelf",
    "ladder rack",
    // Tables / seating sets miscategorised as decor
    "bar table",
    "bar tables",
    "pub table",
    "counter height table",
    "bistro table",
    "dining set",
    "table set",
    "bar set",
    "stool set",
    "chair set",
    // Serving dishes / tableware miscategorised as decor — not counter decor
    "chip n dip",
    "chip and dip",
    "serving platter",
    "serving tray set",
    "serving bowl set",
    "charcuterie board",
    "cheese board",
    "cake stand",
    "deviled egg",
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
    // Pillow/cushion CASES — these are soft furnishing products whose title ends in "Sofa"
    // (e.g. "Boho Pillow Case Plush Sofa") causing inferPrimaryCategory to promote them
    // to the sofa slot in authoritativeSelection. Block at source bucket level.
    "pillow case",
    "cushion case",
    "cushion cover",
    "sofa cover",
    "couch cover",
    "throw pillow",
  ],
  bed: [
    "sink", "faucet", "playhouse",
    // Bedding/linen sets that match "daybed" in title — these are covers, not bed frames
    "daybed cover", "daybed set", "sheet set", "duvet cover set", "comforter set",
    "bedding set", "quilt set", "pillow case", "pillowcase",
  ],
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

// Maps theme keywords → the DB style_tag value to match against item.style_tags
const THEME_TAG_MAP: Record<string, string> = {
  boho: "boho", bohemian: "boho",
  "mid century": "mid_century", "mid-century": "mid_century", midcentury: "mid_century",
  scandinavian: "scandinavian", nordic: "scandinavian", scandi: "scandinavian",
  industrial: "industrial",
  coastal: "coastal", hamptons: "coastal", nautical: "coastal",
  japandi: "japandi",
  luxury: "luxury", glam: "luxury", glamour: "luxury",
  farmhouse: "farmhouse",
  modern: "modern",
  minimalist: "minimalist",
  classic: "classic",
};

function themeStyleTag(theme: string): string | null {
  const lower = theme.toLowerCase();
  for (const [keyword, tag] of Object.entries(THEME_TAG_MAP)) {
    if (lower.includes(keyword)) return tag;
  }
  return null;
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
  // Resolve the DB style_tag for this theme (e.g. "boho", "mid_century")
  const matchTag = themeStyleTag(theme);

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

    // Style tag bonus: strongly prefer items tagged for this theme.
    // Without this, embedding similarity alone can surface wrong-style items
    // (e.g. concrete side table for boho because description says "organic").
    if (matchTag && Array.isArray(item.style_tags) && item.style_tags.includes(matchTag)) {
      score += 8;
    }

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
      style_tags_json,
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
      style_tags: Array.isArray(row.style_tags_json) ? row.style_tags_json : [],
    }));
}

function buildDiversificationSeed(roomType: RoomType, theme: string): string {
  // For Scandinavian, use a fixed seed so the same top products are retrieved on every call.
  // Jitter still applies per-product but the ranking stays stable across runs.
  if (/scandi|scandinavian/i.test(theme)) {
    return `${roomType}|${theme.toLowerCase()}|fixed`;
  }
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
  const isThemeBoho = /\bboho\b|bohemian/i.test(theme);
  const isThemeScandi = /scandi|scandinavian/i.test(theme);
  const SOFA_ROOMS = new Set<RoomType>(["living_room"]);
  const SEATING_QUERY_SUFFIX = "large sectional sofa L shaped couch 3 seater";
  const seatingQueryText = SOFA_ROOMS.has(roomType)
    ? `${theme} ${SEATING_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : queryText;
  const seatingEmbedding = SOFA_ROOMS.has(roomType)
    ? await embedQuery(seatingQueryText)
    : embedding;

  // Boho accent chair: separate query to guarantee a rattan/wicker chair surfaces
  // alongside the sofa. The sectional-biased seating query buries accent_chairs.
  const BOHO_CHAIR_QUERY_SUFFIX = "rattan wicker woven accent armchair bohemian natural";
  const bohoChairQueryText = isThemeBoho && roomType === "living_room"
    ? `${theme} ${BOHO_CHAIR_QUERY_SUFFIX} for living room`
    : null;
  const bohoChairEmbedding = bohoChairQueryText ? await embedQuery(bohoChairQueryText) : null;

  // MCM-biased embedding for the tables bucket — only for living room when theme is mid century.
  // Lift-top/functional coffee tables dominate the default vector space; this suffix steers the
  // embedding toward solid walnut / tapered-leg classic MCM forms that actually score well.
  const MCM_TABLE_QUERY_SUFFIX = "mid century solid walnut tapered leg coffee table 1960s";
  const isThemeMCM = /mid[\s_-]?century|midcentury/i.test(theme);
  const tablesQueryText = roomType === "living_room" && isThemeMCM
    ? `${theme} ${MCM_TABLE_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : queryText;
  const tablesEmbedding = roomType === "living_room" && isThemeMCM
    ? await embedQuery(tablesQueryText)
    : embedding;

  // Boho-biased embeddings for lighting and soft_furnishing buckets.
  // Default lamp embedding surfaces generic modern lamps first; this suffix steers toward
  // rattan/wicker/woven organic lamp forms that actually match Boho style.
  // Default rug embedding surfaces jute/neutral rugs; this suffix steers toward
  // kilim/flatweave geometric patterned rugs that score well for Boho.
  const BOHO_LAMP_QUERY_SUFFIX = "rattan wicker seagrass woven natural floor lamp organic shade bohemian";
  const BOHO_RUG_QUERY_SUFFIX = "kilim flatweave geometric tribal terracotta ochre pattern area rug bohemian";
  const BOHO_TABLE_QUERY_SUFFIX = "rattan wicker woven natural wood carved accent side table bohemian organic";
  // Boho sofa: steer away from black/grey sectionals toward warm earthy fabric sofas
  const BOHO_SOFA_QUERY_SUFFIX = "boucle linen velvet earthy warm terracotta cream beige sofa couch bohemian organic natural";
  const bohoSofaQueryText = isThemeBoho && roomType === "living_room"
    ? `${theme} ${BOHO_SOFA_QUERY_SUFFIX} for living room`
    : null;
  const bohoSofaEmbedding = bohoSofaQueryText ? await embedQuery(bohoSofaQueryText) : null;

  // Scandi sofa: steer away from dark/black sectionals toward light linen/boucle sofas
  // with birch or ash wood legs — the generic sectional query surfaces dark sofas that kill the Scandi palette
  const SCANDI_SOFA_QUERY_SUFFIX = "white oat cream linen boucle wool sofa light birch ash wood legs clean straight arm scandinavian nordic";
  const scandiSofaQueryText = isThemeScandi && roomType === "living_room"
    ? `${theme} ${SCANDI_SOFA_QUERY_SUFFIX} for living room`
    : null;
  const scandiSofaEmbedding = scandiSofaQueryText ? await embedQuery(scandiSofaQueryText) : null;
  const bohoLightingQueryText = isThemeBoho
    ? `${theme} ${BOHO_LAMP_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : null;
  const bohoLightingEmbedding = bohoLightingQueryText ? await embedQuery(bohoLightingQueryText) : null;
  const bohoRugQueryText = isThemeBoho
    ? `${theme} ${BOHO_RUG_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : null;
  const bohoRugEmbedding = bohoRugQueryText ? await embedQuery(bohoRugQueryText) : null;
  // Boho tables: steer toward rattan/wicker/carved-wood accent tables instead of ceramic/glass
  const bohoTablesQueryText = isThemeBoho && roomType === "living_room"
    ? `${theme} ${BOHO_TABLE_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : null;
  const bohoTablesEmbedding = bohoTablesQueryText ? await embedQuery(bohoTablesQueryText) : null;

  // MCM-biased embeddings for lighting and soft_furnishing buckets.
  // Default lamp embedding surfaces generic modern floor/table lamps; this steers toward
  // brass/tripod/tapered-shade forms that define mid-century modern style.
  // Default rug embedding surfaces plain neutrals; this steers toward
  // geometric flatweave / low-pile wool abstract rugs typical of MCM interiors.
  // MCM lamp: steer toward brass/tripod/tapered-shade forms typical of mid-century modern.
  // MCM rug: no suffix — only 9 MCM-tagged rugs in DB, theme-specific query hit a poor product.
  // Generic query + style_tags dedup (score=10 for mid_century tag) handles rug selection better.
  const MCM_LAMP_QUERY_SUFFIX = "brass gold tripod tapered shade walnut base table lamp mid century modern 1960s";
  const mcmLightingQueryText = isThemeMCM && roomType === "living_room"
    ? `${theme} ${MCM_LAMP_QUERY_SUFFIX} for ${roomType.replaceAll("_", " ")}`
    : null;
  const mcmLightingEmbedding = mcmLightingQueryText ? await embedQuery(mcmLightingQueryText) : null;

  const buckets = ROOM_BUCKETS[roomType];
  const diversificationSeed = buildDiversificationSeed(roomType, theme);

  const globalExcludedHandles = [...seenHandles];

  const bucketResults = await Promise.all(
    buckets.map(async (bucket) => {
      // Use bucket-specific embeddings where theme/room warrants it
      const bucketEmbedding =
        bucket.bucket === "seating" ? (bohoSofaEmbedding ?? scandiSofaEmbedding ?? seatingEmbedding) :
        bucket.bucket === "tables" ? (bohoTablesEmbedding ?? tablesEmbedding) :
        bucket.bucket === "lighting" ? (mcmLightingEmbedding ?? bohoLightingEmbedding ?? embedding) :
        bucket.bucket === "soft_furnishing" ? (bohoRugEmbedding ?? embedding) :
        embedding;
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

  // Boho: inject accent_chair candidates into seating so the chair slot gets filled.
  // The sectional-biased seating query buries accent_chairs — we run a separate
  // chair-biased query and guarantee at least 3 accent_chair results in the seating list.
  if (bohoChairEmbedding && bucketResultsMap["seating"]) {
    const chairBucket: BucketConfig = {
      bucket: "seating",
      limit: 4,
      required: false,
      allowedCategories: ["accent_chair"],
    };
    const chairCandidates = await queryBucketCandidates(
      bohoChairEmbedding,
      roomType,
      chairBucket,
      globalExcludedHandles,
      minPrice,
      maxPrice
    );
    const rerankedChairs = rerankBucketItems("seating", chairCandidates, theme, diversificationSeed, roomType);
    // Splice top 3 chairs into the seating list so buildAuthoritativeSelection can fill the chair slot
    const existingHandles = new Set(bucketResultsMap["seating"].map(p => p.product_handle));
    const newChairs = rerankedChairs.filter(p => !existingHandles.has(p.product_handle)).slice(0, 3);
    // Insert after the top sofa so interleaving picks up the chair early
    const [topSofa, ...restSofas] = bucketResultsMap["seating"];
    bucketResultsMap["seating"] = [topSofa, ...newChairs, ...restSofas];
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

// ─── Living-room: explicit per-slot retrieval (all themes) ───────────────────
// Runs one dedicated DB query per slot so there is no ambiguity about which
// product fills which role. Returns up to 3 candidates per slot so the caller
// can fall back when an image is unreachable.
//
// Each theme gets tailored embedding suffixes per slot so the vector search
// lands on the right aesthetic (e.g. light birch for Scandi, marble/gold for
// Luxury, rattan for Boho). Unknown themes fall back to generic queries.

type SlotQueries = {
  sofa: string;
  chair: string;
  coffee_table: string;
  rug: string;
  lamp: string;
};

const LIVING_ROOM_SLOT_QUERIES: Record<string, SlotQueries> = {
  scandinavian: {
    sofa:         "white oat cream linen boucle sofa birch ash wood legs scandinavian nordic",
    chair:        "white cream linen boucle accent armchair birch wood legs minimalist scandinavian",
    coffee_table: "white light oak birch wood minimalist rectangular coffee table scandinavian nordic",
    rug:          "natural wool flatweave minimalist neutral light area rug scandinavian nordic",
    lamp:         "tripod floor lamp minimalist white birch wood scandinavian nordic",
  },
  coastal: {
    sofa:         "white cream linen cotton sofa light driftwood legs coastal nautical beach",
    chair:        "white cream linen accent armchair light wood legs coastal nautical",
    coffee_table: "white natural light wood oval rectangular coffee table coastal driftwood bleached",
    rug:          "jute sisal natural fiber striped area rug coastal nautical",
    lamp:         "white rattan wicker natural shade floor lamp coastal",
  },
  japandi: {
    sofa:         "cream beige boucle wool minimalist low profile sofa oak walnut legs japandi japan nordic",
    chair:        "rattan bamboo natural wood frame minimalist accent armchair structured wabi sabi japandi japan",
    coffee_table: "solid oak walnut natural wood grain low profile minimalist rectangular coffee table japandi japan nordic",
    rug:          "natural wool flatweave minimalist neutral muted area rug japandi",
    lamp:         "washi paper shade wood base minimalist floor lamp japandi japan",
  },
  boho: {
    sofa:         "boucle linen velvet earthy terracotta cream beige sofa couch bohemian organic natural",
    chair:        "rattan wicker woven accent armchair natural bohemian",
    coffee_table: "rattan wicker woven natural carved wood coffee table bohemian",
    rug:          "kilim flatweave geometric tribal terracotta ochre patterned area rug bohemian",
    lamp:         "rattan wicker seagrass woven natural organic shade floor lamp bohemian",
  },
  luxury: {
    sofa:         "velvet tufted plush upholstered gold brass metal leg sofa glamour luxury",
    chair:        "velvet tufted accent armchair gold brass leg luxury glam",
    coffee_table: "marble top gold brass metal frame coffee table luxury glam",
    rug:          "plush high pile wool silk abstract area rug luxury",
    lamp:         "gold brass arc floor lamp tall standing luxury glam",
  },
  industrial: {
    sofa:         "dark leather grey fabric sofa metal frame legs industrial urban loft",
    chair:        "leather accent armchair metal legs industrial urban loft",
    coffee_table: "reclaimed wood metal pipe frame coffee table industrial urban",
    rug:          "grey abstract textured marble low pile luxe area rug industrial urban loft",
    lamp:         "black metal exposed Edison bulb tripod floor lamp industrial",
  },
  farmhouse: {
    sofa:         "cozy linen cotton cream distressed wood sofa farmhouse rustic",
    chair:        "cozy linen cotton cream accent armchair farmhouse rustic",
    coffee_table: "reclaimed wood rustic rectangular coffee table farmhouse",
    rug:          "jute braided cotton natural area rug farmhouse",
    lamp:         "galvanized metal rustic floor lamp farmhouse",
  },
  mid_century: {
    sofa:         "walnut tapered leg wool upholstered sofa mid century modern 1960s retro",
    chair:        "walnut tapered leg accent armchair wool mid century modern 1960s",
    coffee_table: "solid walnut tapered leg rectangular coffee table mid century modern 1960s",
    rug:          "geometric flatweave wool abstract area rug mid century modern",
    lamp:         "brass gold tripod tapered shade walnut base floor lamp mid century modern",
  },
  modern: {
    sofa:         "sleek clean line minimalist grey white neutral sectional sofa modern",
    chair:        "minimalist accent armchair clean lines neutral upholstered modern",
    coffee_table: "minimalist glass marble rectangular coffee table modern",
    rug:          "geometric abstract neutral low pile area rug modern",
    lamp:         "minimalist arc floor lamp clean line modern",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// KITCHEN SLOT QUERIES
// 4 slots: stool (island seating), chair (dining area seating), lamp, decor
// Both stool + chair always retrieved — FLUX uses whichever the scene calls for.
// Themes: modern, industrial, luxury, farmhouse, mid_century
// ─────────────────────────────────────────────────────────────────────────────
type KitchenSlotQueries = {
  stool:   string;
  chair:   string;
  lamp:    string;
  decor:   string;
  cabinet: string;
};

// "cabinet" here = kitchen wall cabinet / pantry storage unit — NOT a living room display cabinet.
// The DB query uses allowedCategories=["kitchen_storage","cabinet","shelf"] + room filter = "kitchen"
// so only kitchen-tagged products surface. Living room retrieval is completely separate.
const KITCHEN_SLOT_QUERIES: Record<string, KitchenSlotQueries> = {
  modern: {
    stool:   "minimalist bar stool counter height white black metal swivel upholstered modern kitchen",
    chair:   "minimalist dining chair white black upholstered clean line modern kitchen",
    lamp:    "minimalist glass globe pendant light black matte chrome ceiling kitchen island modern",
    decor:   "minimalist ceramic vase bowl white black counter decor modern kitchen",
    cabinet: "white gloss flat panel kitchen wall cabinet pantry storage unit modern minimalist",
  },
  industrial: {
    stool:   "black metal bar stool counter height industrial urban loft kitchen",
    chair:   "black metal dining chair industrial urban loft wood seat",
    lamp:    "black metal cage pendant light Edison bulb exposed industrial kitchen island",
    decor:   "black iron metal wire basket tray counter decor industrial kitchen",
    cabinet: "dark oak black metal kitchen wall cabinet pantry storage unit industrial urban loft",
  },
  luxury: {
    stool:   "velvet upholstered bar stool gold brass metal frame counter height luxury glam kitchen",
    chair:   "velvet upholstered dining chair gold brass leg luxury glam",
    lamp:    "gold brass crystal pendant light ceiling fixture luxury glam kitchen island",
    decor:   "marble ceramic gold vase tray bowl counter decor luxury kitchen",
    cabinet: "gloss white gold brass handle kitchen wall cabinet pantry storage luxury glam high end",
  },
  boho: {
    stool:   "rattan cane wicker counter stool natural wood bohemian boho kitchen",
    chair:   "rattan cane wicker dining chair natural wood bohemian boho",
    lamp:    "woven rattan pendant light natural boho kitchen island bohemian ceiling",
    decor:   "terracotta clay pot ceramic macrame plant pot counter decor boho kitchen",
    cabinet: "natural wood open shelf kitchen wall cabinet rattan insert bohemian boho storage unit",
  },
  farmhouse: {
    stool:   "wood seat counter stool rustic natural farmhouse kitchen",
    chair:   "wood dining chair rustic natural farmhouse shaker",
    lamp:    "galvanized metal barn pendant light farmhouse rustic kitchen island",
    decor:   "ceramic pitcher mason jar natural wood tray farmhouse counter decor kitchen",
    cabinet: "shaker white wood kitchen wall cabinet pantry storage unit farmhouse rustic traditional",
  },
  mid_century: {
    stool:   "walnut tapered leg counter stool upholstered mid century modern kitchen 1960s",
    chair:   "walnut tapered leg dining chair upholstered wool mid century modern 1960s",
    lamp:    "brass copper dome pendant light mid century modern kitchen island retro",
    decor:   "ceramic teak wood bowl tray retro counter decor mid century modern kitchen",
    cabinet: "walnut wood flat panel kitchen wall cabinet pantry storage unit mid century modern retro",
  },
};

function getKitchenSlotQueries(theme: string): KitchenSlotQueries {
  const lower = theme.toLowerCase();
  if (/industrial/i.test(lower))                       return KITCHEN_SLOT_QUERIES.industrial;
  if (/luxury|glam/i.test(lower))                      return KITCHEN_SLOT_QUERIES.luxury;
  if (/boho|bohemian/i.test(lower))                    return KITCHEN_SLOT_QUERIES.boho;
  if (/farmhouse/i.test(lower))                        return KITCHEN_SLOT_QUERIES.farmhouse;
  if (/mid[\s_-]?century|midcentury/i.test(lower))     return KITCHEN_SLOT_QUERIES.mid_century;
  // Default to modern for unrecognised themes
  return KITCHEN_SLOT_QUERIES.modern;
}

export async function retrieveKitchenSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "kitchen";
  const seed = `kitchen|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const q = getKitchenSlotQueries(theme);

  const [stoolEmb, chairEmb, lampEmb, decorEmb, cabinetEmb] = await Promise.all([
    embedQuery(`${theme} ${q.stool}`),
    embedQuery(`${theme} ${q.chair}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.decor}`),
    embedQuery(`${theme} kitchen ${q.cabinet}`),
  ]);

  const LIMIT = 25;

  const [stools, chairs, lamps, decor, cabinets] = await Promise.all([
    queryBucketCandidates(stoolEmb,   roomType, { bucket: "seating",  limit: LIMIT, required: true,  allowedCategories: ["bar_stool"] },                              [], minPrice, maxPrice),
    queryBucketCandidates(chairEmb,   roomType, { bucket: "seating",  limit: LIMIT, required: false, allowedCategories: ["dining_chair", "accent_chair"] },            [], minPrice, maxPrice),
    // Kitchen allows ceiling fixtures (pendants/chandeliers) — no lighting BUCKET_EXCLUDES applied
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting", limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                                    [], minPrice, maxPrice),
    queryBucketCandidates(decorEmb,   roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["decor", "artificial_plant"] },               [], minPrice, maxPrice),
    // Kitchen wall cabinets / pantry units — storage bucket, kitchen room filter ensures only kitchen products
    queryBucketCandidates(cabinetEmb, roomType, { bucket: "storage",  limit: LIMIT, required: false, allowedCategories: ["kitchen_storage", "cabinet", "shelf"] },     [], minPrice, maxPrice),
  ]);

  return [
    { slot: "stool",   products: rerankBucketItems("seating",  stools,   theme, seed, roomType).slice(0, 12) },
    { slot: "chair",   products: rerankBucketItems("seating",  chairs,   theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",    products: rerankBucketItems("lighting", lamps,    theme, seed, roomType).slice(0, 12) },
    { slot: "decor",   products: rerankBucketItems("decor",    decor,    theme, seed, roomType).slice(0, 12) },
    { slot: "cabinet", products: rerankBucketItems("storage",  cabinets, theme, seed, roomType).slice(0, 12) },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// BEDROOM per-slot retrieval
// Slots: bed (hero), nightstand, lamp, bedding, dresser
// Themes: scandi, japandi, coastal, luxury, boho, mid_century, modern (default)
// ─────────────────────────────────────────────────────────────────────────────
type BedroomSlotQueries = {
  bed:       string;
  nightstand: string;
  lamp:      string;
  bedding:   string;
  dresser:   string;
};

const BEDROOM_SLOT_QUERIES: Record<string, BedroomSlotQueries> = {
  scandi: {
    bed:       "white oak platform bed frame low profile minimal Nordic Scandinavian bedroom",
    nightstand: "white oak nightstand bedside table minimal Nordic Scandinavian simple clean",
    lamp:      "white linen drum shade bedside table lamp warm minimal Nordic Scandinavian",
    bedding:   "duvet cover set white grey cotton bedroom Scandinavian neutral",
    dresser:   "white oak chest of drawers minimal Nordic Scandinavian clean simple",
  },
  japandi: {
    bed:       "low profile platform bed frame solid light oak wood upholstered headboard minimal Japandi queen king bedroom",
    nightstand: "bamboo light oak low profile bedside nightstand minimal Japandi natural simple",
    lamp:      "ceramic washi paper shade warm bedside table lamp minimal Japandi wabi sabi solid base bedroom",
    bedding:   "natural linen cotton neutral ivory duvet Japandi minimal bedroom",
    dresser:   "light oak low chest of drawers minimal Japandi natural wood simple",
  },
  coastal: {
    bed:       "white rattan cane wicker platform bed frame coastal beach relaxed bedroom",
    nightstand: "white rattan wicker nightstand coastal natural light wood bedside",
    lamp:      "white ceramic linen bedside table lamp sandy coastal natural",
    bedding:   "blue white stripe linen cotton coastal beach duvet bedroom",
    dresser:   "white driftwood coastal chest of drawers rattan handles",
  },
  luxury: {
    bed:       "king size upholstered velvet tufted platform bed frame gold trim luxury glam statement bedroom",
    nightstand: "marble top gold brass nightstand luxury glam velvet bedside table",
    lamp:      "crystal gold brass bedside table lamp luxury glam warm light",
    bedding:   "velvet silk satin luxury duvet cover champagne gold cream bedroom",
    dresser:   "white lacquer gold hardware luxury glamour chest of drawers dresser",
  },
  boho: {
    bed:       "rattan cane macrame woven platform bed frame bohemian eclectic warm bedroom",
    nightstand: "rattan wicker wooden nightstand boho bohemian bedside natural",
    lamp:      "rattan wicker jute bohemian bedside table lamp terracotta warm earthy",
    bedding:   "patterned block print cotton boho bohemian duvet cover colourful bedroom",
    dresser:   "rattan natural wood chest of drawers boho bohemian vintage",
  },
  mid_century: {
    bed:       "walnut tapered leg platform bed frame mid century modern upholstered retro bedroom",
    nightstand: "walnut tapered leg bedside nightstand mid century modern retro",
    lamp:      "brass walnut mid century modern bedside table lamp retro warm tripod",
    bedding:   "geometric pattern cotton mid century modern duvet cover bedroom",
    dresser:   "walnut tapered leg chest of drawers mid century modern retro",
  },
  modern: {
    bed:       "upholstered platform bed frame grey white black clean line modern minimalist bedroom",
    nightstand: "white grey modern minimalist nightstand bedside table clean contemporary",
    lamp:      "white black geometric modern minimalist bedside table lamp clean",
    bedding:   "white grey cotton modern minimalist duvet cover bedroom clean",
    dresser:   "white modern chest of drawers clean minimal contemporary",
  },
};

function getBedroomSlotQueries(theme: string): BedroomSlotQueries {
  const lower = theme.toLowerCase();
  if (/scandi|scandinavian|nordic/i.test(lower))       return BEDROOM_SLOT_QUERIES.scandi;
  if (/japandi/i.test(lower))                          return BEDROOM_SLOT_QUERIES.japandi;
  if (/coastal|hampton|nautical|beach/i.test(lower))   return BEDROOM_SLOT_QUERIES.coastal;
  if (/luxury|glam/i.test(lower))                      return BEDROOM_SLOT_QUERIES.luxury;
  if (/boho|bohemian/i.test(lower))                    return BEDROOM_SLOT_QUERIES.boho;
  if (/mid[\s_-]?century|midcentury/i.test(lower))     return BEDROOM_SLOT_QUERIES.mid_century;

  // ── Heuristic mapping for custom/free-text themes ──────────────────────
  // Map broad style families to the closest predefined query set so that
  // catalogue results are at least thematically adjacent.
  if (/indian|moroccan|ethnic|oriental|persian|turkish|arabian|arabic/i.test(lower))  return BEDROOM_SLOT_QUERIES.boho;
  if (/tropical|caribbean|hawaiian|bali|balinese/i.test(lower))                       return BEDROOM_SLOT_QUERIES.coastal;
  if (/art\s*deco|hollywood|regency|royal|palace|victorian|baroque/i.test(lower))     return BEDROOM_SLOT_QUERIES.luxury;
  if (/zen|wabi[\s-]?sabi|korean|muji|asian/i.test(lower))                            return BEDROOM_SLOT_QUERIES.japandi;
  if (/retro|vintage|70s|60s|50s/i.test(lower))                                       return BEDROOM_SLOT_QUERIES.mid_century;
  if (/cabin|cottage|country|rustic|ranch/i.test(lower))                               return BEDROOM_SLOT_QUERIES.scandi;

  return BEDROOM_SLOT_QUERIES.modern;
}

// ─── Kids Room per-slot retrieval ────────────────────────────────────────────

type KidsRoomSlotQueries = {
  bed: string; lamp: string; rug: string; storage: string; decor: string;
};

const KIDS_ROOM_SLOT_QUERIES: Record<string, KidsRoomSlotQueries> = {
  scandi: {
    bed:     "white pine single twin bed frame platform Nordic Scandinavian kids bedroom",
    lamp:    "white mushroom cloud bedside table lamp warm minimal Nordic kids room",
    rug:     "round cream white soft play mat rug Nordic Scandinavian kids room cotton",
    storage: "white pine open bookshelf toy storage minimal Nordic kids bedroom",
    decor:   "animal forest nature framed wall art print Scandinavian kids room",
  },
  coastal: {
    bed:     "white wood coastal farmhouse single twin platform bed frame kids room natural pine",
    lamp:    "white ceramic rattan woven table lamp warm coastal kids bedroom",
    rug:     "blue teal stripe washable cotton kids area rug coastal bedroom",
    storage: "white natural rattan bookshelf kids storage coastal open shelving",
    decor:   "ocean beach surf waves framed wall art print kids room coastal",
  },
  bohemian: {
    bed:     "rattan cane woven kids single twin platform bed frame boho bedroom colorful",
    lamp:    "earthy terracotta rattan woven kids bedside table lamp warm amber boho natural",
    rug:     "colorful pattern boho washable kids play area rug soft cotton",
    storage: "rattan wicker boho kids toy storage bookshelf open natural",
    decor:   "colorful boho framed wall art print kids room eclectic fun",
  },
  modern: {
    bed:     "upholstered kids single twin platform bed frame clean line modern white grey",
    lamp:    "kids fun colorful modern table lamp warm bedside contemporary bedroom",
    rug:     "geometric bold colorful modern kids washable area rug contemporary",
    storage: "modern open bookshelf kids storage white contemporary clean shelving",
    decor:   "geometric colorful framed wall art print kids room modern contemporary",
  },
  japandi: {
    bed:     "natural wood low platform single twin bed frame minimal kids bedroom wabi-sabi bamboo",
    lamp:    "washi paper warm pendant table lamp minimal kids bedroom natural japandi",
    rug:     "natural jute cotton soft kids area rug minimal muted tones japandi bedroom",
    storage: "light oak natural wood open shelf kids storage minimal japandi bedroom",
    decor:   "nature botanical minimal framed wall art print kids room japandi calm",
  },
  luxury: {
    bed:     "upholstered velvet single twin kids platform bed frame tufted elegant premium",
    lamp:    "crystal brass elegant kids bedside table lamp warm luxury bedroom premium",
    rug:     "soft plush thick kids area rug premium luxe bedroom warm neutral",
    storage: "painted white gloss cabinet kids storage dresser elegant premium bedroom",
    decor:   "framed gold elegant kids wall art print premium luxury bedroom",
  },
  industrial: {
    bed:     "metal pipe frame single twin kids platform bed frame dark steel industrial",
    lamp:    "industrial metal adjustable kids desk floor lamp warm Edison kids bedroom",
    rug:     "grey black geometric cotton washable kids area rug urban industrial",
    storage: "metal wire open shelf kids storage industrial dark frame bookshelf",
    decor:   "vintage map urban industrial framed wall art print kids room",
  },
  mid_century: {
    bed:     "walnut wood tapered leg single twin kids platform bed frame mid century modern",
    lamp:    "walnut brass mid century modern kids bedside table lamp warm retro",
    rug:     "retro geometric pattern soft kids area rug mid century modern warm tones",
    storage: "walnut tapered leg kids bookshelf storage open mid century modern",
    decor:   "retro geometric colorful framed wall art print kids room mid century",
  },
};

function getKidsRoomSlotQueries(theme: string): KidsRoomSlotQueries {
  const lower = theme.toLowerCase();
  if (/scandi|scandinavian|nordic/i.test(lower))    return KIDS_ROOM_SLOT_QUERIES.scandi;
  if (/coastal|beach|nautical/i.test(lower))        return KIDS_ROOM_SLOT_QUERIES.coastal;
  if (/boho|bohemian/i.test(lower))                 return KIDS_ROOM_SLOT_QUERIES.bohemian;
  if (/japandi/i.test(lower))                       return KIDS_ROOM_SLOT_QUERIES.japandi;
  if (/luxury|glam/i.test(lower))                   return KIDS_ROOM_SLOT_QUERIES.luxury;
  if (/industrial/i.test(lower))                    return KIDS_ROOM_SLOT_QUERIES.industrial;
  if (/mid[\s_-]?century|midcentury/i.test(lower))  return KIDS_ROOM_SLOT_QUERIES.mid_century;
  return KIDS_ROOM_SLOT_QUERIES.modern;
}

export async function retrieveKidsRoomSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "kids_room";
  const seed = `kids_room|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const q = getKidsRoomSlotQueries(theme);

  const [bedEmb, lampEmb, rugEmb, storageEmb, decorEmb] = await Promise.all([
    embedQuery(`${theme} ${q.bed}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.rug}`),
    embedQuery(`${theme} ${q.storage}`),
    embedQuery(`${theme} ${q.decor}`),
  ]);

  const LIMIT = 25;

  const [beds, lamps, rugs, storage, decor] = await Promise.all([
    queryBucketCandidates(bedEmb,     roomType, { bucket: "bed",      limit: LIMIT, required: true,  allowedCategories: ["bed"] },                              [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting", limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                             [], minPrice, maxPrice),
    queryBucketCandidates(rugEmb,     roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["rug"] },                          [], minPrice, maxPrice),
    queryBucketCandidates(storageEmb, roomType, { bucket: "storage",  limit: LIMIT, required: false, allowedCategories: ["bookshelf", "storage", "cabinet"] },   [], minPrice, maxPrice),
    queryBucketCandidates(decorEmb,   roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["wall_art"] },                          [], minPrice, maxPrice),
  ]);

  return [
    { slot: "bed",     products: rerankBucketItems("bed",      beds,    theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",    products: rerankBucketItems("lighting", lamps,   theme, seed, roomType).slice(0, 12) },
    { slot: "rug",     products: rerankBucketItems("soft_furnishing", rugs,    theme, seed, roomType).slice(0, 12) },
    { slot: "storage", products: rerankBucketItems("storage",  storage, theme, seed, roomType).slice(0, 12) },
    { slot: "decor",   products: rerankBucketItems("decor",    decor,   theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Hallway per-slot retrieval ──────────────────────────────────────────────

type HallwaySlotQueries = {
  console: string; mirror: string; lamp: string; rug: string; bench: string;
};

const HALLWAY_SLOT_QUERIES: Record<string, HallwaySlotQueries> = {
  scandi: {
    console: "white oak slim console table minimal Nordic Scandinavian entryway hallway",
    mirror:  "round white oak framed wall mirror minimal Nordic Scandinavian hallway",
    lamp:    "white ceramic linen bedside table lamp warm minimal Nordic Scandinavian entryway",
    rug:     "natural cotton cream runner rug minimal Nordic Scandinavian hallway",
    bench:   "white oak upholstered cushion bench minimal Nordic Scandinavian entryway",
  },
  japandi: {
    console: "walnut light oak slim console table minimal Japandi Japanese entryway hallway",
    mirror:  "wooden oval framed wall mirror minimal Japandi Japanese hallway wabi-sabi",
    lamp:    "washi paper ceramic warm bedside table lamp minimal Japandi Japanese entryway",
    rug:     "natural jute linen runner rug minimal Japandi Japanese hallway",
    bench:   "walnut oak low bench seat minimal Japandi Japanese entryway hallway",
  },
  coastal: {
    console: "white rattan wicker slim console table coastal natural entryway hallway",
    mirror:  "white driftwood rattan framed wall mirror coastal beach hallway",
    lamp:    "white ceramic coastal linen bedside table lamp entryway warm natural",
    rug:     "jute natural sisal runner rug coastal beach hallway",
    bench:   "white coastal rattan wicker bench entryway hallway natural",
  },
  luxury: {
    console: "marble top gold brass console table luxury glam statement entryway hallway",
    mirror:  "gold brass ornate large arched wall mirror luxury glam entryway hallway",
    lamp:    "crystal gold brass bedside table lamp luxury glam entryway hallway warm",
    rug:     "wool luxury runner rug entryway hallway plush elegant",
    bench:   "velvet tufted gold legs bench luxury glam entryway statement",
  },
  mid_century: {
    console: "walnut tapered leg slim console table mid century modern entryway hallway retro",
    mirror:  "walnut sunburst framed wall mirror mid century modern hallway retro",
    lamp:    "brass walnut mid century modern bedside table lamp entryway hallway",
    rug:     "geometric pattern runner rug mid century modern hallway retro",
    bench:   "walnut tapered leg upholstered bench mid century modern entryway hallway",
  },
  modern: {
    console: "white grey slim console table modern minimalist clean entryway hallway",
    mirror:  "black metal framed large rectangular wall mirror modern minimalist hallway",
    lamp:    "modern geometric bedside table lamp clean white black entryway hallway",
    rug:     "grey white geometric modern runner rug minimalist hallway",
    bench:   "modern upholstered white grey bench minimalist entryway hallway",
  },
};

function getHallwaySlotQueries(theme: string): HallwaySlotQueries {
  const lower = theme.toLowerCase();
  if (/scandi|scandinavian|nordic/i.test(lower))    return HALLWAY_SLOT_QUERIES.scandi;
  if (/japandi/i.test(lower))                       return HALLWAY_SLOT_QUERIES.japandi;
  if (/coastal|beach|nautical/i.test(lower))        return HALLWAY_SLOT_QUERIES.coastal;
  if (/luxury|glam/i.test(lower))                   return HALLWAY_SLOT_QUERIES.luxury;
  if (/mid[\s_-]?century|midcentury/i.test(lower))  return HALLWAY_SLOT_QUERIES.mid_century;
  return HALLWAY_SLOT_QUERIES.modern;
}

export async function retrieveHallwaySlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "hallway";
  const seed = `hallway|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;
  const q = getHallwaySlotQueries(theme);

  const [consoleEmb, mirrorEmb, lampEmb, rugEmb, benchEmb] = await Promise.all([
    embedQuery(`${theme} ${q.console}`),
    embedQuery(`${theme} ${q.mirror}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.rug}`),
    embedQuery(`${theme} ${q.bench}`),
  ]);

  const LIMIT = 25;
  const [consoles, mirrors, lamps, rugs, benches] = await Promise.all([
    queryBucketCandidates(consoleEmb, roomType, { bucket: "tables",          limit: LIMIT, required: true,  allowedCategories: ["console_table", "side_table"] }, [], minPrice, maxPrice),
    queryBucketCandidates(mirrorEmb,  roomType, { bucket: "decor",           limit: LIMIT, required: true,  allowedCategories: ["mirror"] },                     [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting",        limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                       [], minPrice, maxPrice),
    queryBucketCandidates(rugEmb,     roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["rug"] },                        [], minPrice, maxPrice),
    queryBucketCandidates(benchEmb,   roomType, { bucket: "seating",         limit: LIMIT, required: false, allowedCategories: ["bench", "ottoman"] },            [], minPrice, maxPrice),
  ]);

  return [
    { slot: "console", products: rerankBucketItems("tables",          consoles, theme, seed, roomType).slice(0, 12) },
    { slot: "mirror",  products: rerankBucketItems("decor",           mirrors,  theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",    products: rerankBucketItems("lighting",        lamps,    theme, seed, roomType).slice(0, 12) },
    { slot: "rug",     products: rerankBucketItems("soft_furnishing", rugs,     theme, seed, roomType).slice(0, 12) },
    { slot: "bench",   products: rerankBucketItems("seating",         benches,  theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Loft per-slot retrieval ──────────────────────────────────────────────────

type LoftSlotQueries = {
  table: string; lamp: string; wall_art: string; mirror: string; bench: string;
};

// TV-related terms that must never win the console/table slot in foyer/loft/hallway
const ENTRYWAY_TABLE_WRONG_TERMS = ["tv console", "television console", "tv stand", "media console", "media center", "entertainment center"];
function filterEntryTables(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !ENTRYWAY_TABLE_WRONG_TERMS.some(t => title.includes(t));
  });
}

// Desk/task/wall lamps are wrong for foyer/loft lamp slot — a floor lamp or arc lamp is needed
const ENTRYWAY_LAMP_WRONG_TERMS = [
  "desk lamp", "task lamp", "clip lamp", "clamp lamp",
  "wall sconce", "sconce", "wall lamp", "plug-in wall",
  "ceiling lamp", "flush mount", "semi-flush", "chandelier",
  "set of 2", "set of 3", "set of 4",
];
function filterEntryLamps(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !ENTRYWAY_LAMP_WRONG_TERMS.some(t => title.includes(t));
  });
}

// Twin/bunk/daybed frames are never appropriate for a main bedroom visualisation
const BEDROOM_BED_WRONG_TERMS = [
  "twin metal", "twin platform", "twin size", "twin bed frame",
  "bunk bed", "loft bed", "daybed", "sleeper sofa",
  "twin over", "full over",
];
function filterBedroomBeds(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !BEDROOM_BED_WRONG_TERMS.some(t => title.includes(t));
  });
}

// Small nightstands must not win the dresser slot — only full-size multi-drawer chests qualify
// DB has no separate "dresser" category; compact 1–2 drawer pieces are tagged "nightstand"
// so we allow nightstand in the dresser query but block small/compact ones by title keyword
const DRESSER_WRONG_TERMS = [
  "1-drawer", "1 drawer", "one drawer",
  "2-drawer nightstand", "2 drawer nightstand",
  "bedside table", "beside table",
  "end table", "side table",
  "nightstand with charging", "nightstand with led",
  "narrow nightstand", "slim nightstand",
  "space saver", "compact",
];
function filterBedroomDressers(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !DRESSER_WRONG_TERMS.some(t => title.includes(t));
  });
}

// Pendant/ceiling fixtures cause geometry drift when placed in bedrooms — only floor/table lamps allowed
const BEDROOM_LAMP_WRONG_TERMS = [
  "pendant lamp", "pendant light", "pendant lighting",
  "hanging lamp", "hanging light", "hanging pendant",
  "ceiling lamp", "ceiling light", "ceiling fixture",
  "flush mount", "semi-flush", "chandelier",
  "wall sconce", "sconce", "wall lamp",
  "set of 2", "set of 3", "set of 4",
  // "rattan lamps" (plural, no floor/table prefix) = ceiling/wall fixture set — FLUX mounts on wall → geometry drift
  // Note: "rattan table lamp" / "rattan floor lamp" do NOT match this substring
  "rattan lamps",
];
function filterBedroomLamps(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !BEDROOM_LAMP_WRONG_TERMS.some(t => title.includes(t));
  });
}

// Vanity/bathroom mirrors must not win the foyer/loft/hallway mirror slot
const ENTRYWAY_MIRROR_WRONG_TERMS = [
  "vanity mirror", "bathroom mirror", "medicine cabinet", "makeup mirror",
  "lighted mirror", "led mirror", "magnifying mirror", "beveled edge",
];
function filterEntryMirrors(products: RetrievedProduct[]): RetrievedProduct[] {
  return products.filter(p => {
    const title = (p.title ?? "").toLowerCase();
    return !ENTRYWAY_MIRROR_WRONG_TERMS.some(t => title.includes(t));
  });
}

const LOFT_SLOT_QUERIES: Record<string, LoftSlotQueries> = {
  scandi: {
    table:    "white oak console accent table minimal Nordic Scandinavian loft foyer",
    lamp:     "white tall arc floor lamp minimal Nordic Scandinavian loft foyer warm",
    wall_art: "minimal nature abstract large framed print wall art Nordic Scandinavian loft",
    mirror:   "large round white oak framed wall mirror minimal Nordic Scandinavian loft",
    bench:    "white oak upholstered bench minimal Nordic Scandinavian loft foyer",
  },
  japandi: {
    table:    "walnut light oak low console accent table minimal Japandi loft foyer",
    lamp:     "natural rattan bamboo tall arc floor lamp minimal warm Japandi loft foyer",
    wall_art: "minimal ink abstract nature large framed wall art Japanese Japandi loft",
    mirror:   "wooden oval large framed wall mirror minimal Japandi loft foyer",
    bench:    "walnut oak low upholstered bench minimal Japandi loft foyer",
  },
  coastal: {
    table:    "white rattan wicker console accent table coastal natural loft foyer",
    lamp:     "rattan tall arc floor lamp coastal natural warm loft foyer",
    wall_art: "coastal ocean beach large abstract framed print wall art loft foyer",
    mirror:   "white driftwood rattan large wall mirror coastal loft foyer",
    bench:    "white coastal rattan wicker bench loft foyer natural",
  },
  luxury: {
    table:    "marble top gold brass console accent table luxury glam loft foyer",
    lamp:     "crystal gold brass tall arc floor lamp luxury glam statement loft foyer",
    wall_art: "large gold framed abstract canvas wall art luxury glam loft foyer statement",
    mirror:   "gold brass ornate large oversized wall mirror luxury glam loft foyer",
    bench:    "velvet tufted gold legs bench luxury glam loft foyer statement",
  },
  industrial: {
    table:    "black steel reclaimed wood industrial console accent table loft foyer",
    lamp:     "black matte industrial tall arc floor lamp Edison metal loft foyer",
    wall_art: "industrial abstract urban black metal framed art print loft foyer",
    mirror:   "black metal pipe framed large industrial mirror loft foyer",
    bench:    "black steel reclaimed wood industrial bench loft foyer",
  },
  mid_century: {
    table:    "walnut tapered leg console accent table mid century modern loft foyer retro",
    lamp:     "brass walnut tall arc floor lamp mid century modern retro loft foyer",
    wall_art: "mid century modern geometric abstract large framed print art loft foyer",
    mirror:   "walnut sunburst starburst large framed wall mirror mid century modern loft",
    bench:    "walnut tapered leg upholstered bench mid century modern loft foyer",
  },
  modern: {
    table:    "white grey slim console accent table modern minimalist loft foyer",
    lamp:     "modern geometric white black tall arc floor lamp minimalist loft foyer",
    wall_art: "modern abstract geometric large framed canvas wall art loft foyer",
    mirror:   "black metal framed large round wall mirror modern minimalist loft foyer",
    bench:    "modern white grey upholstered bench minimalist loft foyer contemporary",
  },
};

function getLoftSlotQueries(theme: string): LoftSlotQueries {
  const lower = theme.toLowerCase();
  if (/scandi|scandinavian|nordic/i.test(lower))    return LOFT_SLOT_QUERIES.scandi;
  if (/japandi/i.test(lower))                       return LOFT_SLOT_QUERIES.japandi;
  if (/coastal|beach|nautical/i.test(lower))        return LOFT_SLOT_QUERIES.coastal;
  if (/luxury|glam/i.test(lower))                   return LOFT_SLOT_QUERIES.luxury;
  if (/industrial/i.test(lower))                    return LOFT_SLOT_QUERIES.industrial;
  if (/mid[\s_-]?century|midcentury/i.test(lower))  return LOFT_SLOT_QUERIES.mid_century;
  return LOFT_SLOT_QUERIES.modern;
}

export async function retrieveLoftSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "loft";
  const seed = `loft|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;
  const q = getLoftSlotQueries(theme);

  const [tableEmb, lampEmb, wallArtEmb, mirrorEmb, benchEmb] = await Promise.all([
    embedQuery(`${theme} ${q.table}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.wall_art}`),
    embedQuery(`${theme} ${q.mirror}`),
    embedQuery(`${theme} ${q.bench}`),
  ]);

  const LIMIT = 25;
  const [tablesRaw, lampsRaw, wallArts, mirrorsRaw, benches] = await Promise.all([
    queryBucketCandidates(tableEmb,   roomType, { bucket: "tables",   limit: LIMIT, required: true,  allowedCategories: ["console_table", "side_table", "coffee_table"] },                    [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting", limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                                                            [], minPrice, maxPrice),
    queryBucketCandidates(wallArtEmb, roomType, { bucket: "wall_art", limit: LIMIT, required: true,  allowedCategories: ["wall_art", "framed_art", "canvas_art", "wall_hanging"] },            [], minPrice, maxPrice),
    queryBucketCandidates(mirrorEmb,  roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["mirror"] },                                                          [], minPrice, maxPrice),
    queryBucketCandidates(benchEmb,   roomType, { bucket: "seating",  limit: LIMIT, required: false, allowedCategories: ["bench", "ottoman", "accent_chair"] },                               [], minPrice, maxPrice),
  ]);
  const tables  = filterEntryTables(tablesRaw);
  const lamps   = filterEntryLamps(lampsRaw);
  const mirrors = filterEntryMirrors(mirrorsRaw);

  return [
    { slot: "table",    products: rerankBucketItems("tables",   tables,   theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",     products: rerankBucketItems("lighting", lamps,    theme, seed, roomType).slice(0, 12) },
    { slot: "wall_art", products: rerankBucketItems("wall_art", wallArts, theme, seed, roomType).slice(0, 12) },
    { slot: "mirror",   products: rerankBucketItems("decor",    mirrors,  theme, seed, roomType).slice(0, 12) },
    { slot: "bench",    products: rerankBucketItems("seating",  benches,  theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Foyer per-slot retrieval (same queries as loft, roomType = "foyer") ──────

export async function retrieveFoyerSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "foyer";
  const seed = `foyer|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;
  const q = getLoftSlotQueries(theme); // reuse loft slot queries — same products

  const [tableEmb, lampEmb, wallArtEmb, mirrorEmb, benchEmb] = await Promise.all([
    embedQuery(`${theme} ${q.table}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.wall_art}`),
    embedQuery(`${theme} ${q.mirror}`),
    embedQuery(`${theme} ${q.bench}`),
  ]);

  const LIMIT = 25;
  const [tablesRaw, lampsRaw, wallArts, mirrorsRaw, benches] = await Promise.all([
    queryBucketCandidates(tableEmb,   roomType, { bucket: "tables",   limit: LIMIT, required: true,  allowedCategories: ["console_table", "side_table", "coffee_table"] },                    [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting", limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                                                            [], minPrice, maxPrice),
    queryBucketCandidates(wallArtEmb, roomType, { bucket: "wall_art", limit: LIMIT, required: true,  allowedCategories: ["wall_art", "framed_art", "canvas_art", "wall_hanging"] },            [], minPrice, maxPrice),
    queryBucketCandidates(mirrorEmb,  roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["mirror"] },                                                          [], minPrice, maxPrice),
    queryBucketCandidates(benchEmb,   roomType, { bucket: "seating",  limit: LIMIT, required: false, allowedCategories: ["bench", "ottoman", "accent_chair"] },                               [], minPrice, maxPrice),
  ]);
  const tables  = filterEntryTables(tablesRaw);
  const lamps   = filterEntryLamps(lampsRaw);
  const mirrors = filterEntryMirrors(mirrorsRaw);

  return [
    { slot: "table",    products: rerankBucketItems("tables",   tables,   theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",     products: rerankBucketItems("lighting", lamps,    theme, seed, roomType).slice(0, 12) },
    { slot: "wall_art", products: rerankBucketItems("wall_art", wallArts, theme, seed, roomType).slice(0, 12) },
    { slot: "mirror",   products: rerankBucketItems("decor",    mirrors,  theme, seed, roomType).slice(0, 12) },
    { slot: "bench",    products: rerankBucketItems("seating",  benches,  theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Frontyard per-slot retrieval ─────────────────────────────────────────────

type FrontyardSlotQueries = {
  seating: string; table: string; lighting: string; planter: string;
};

const FRONTYARD_SLOT_QUERIES: Record<string, FrontyardSlotQueries> = {
  coastal: {
    seating:  "white rattan wicker outdoor bench chair coastal natural garden front porch",
    table:    "white rattan wicker outdoor side accent table coastal garden porch natural",
    lighting: "white outdoor solar lantern lamp coastal natural garden front porch",
    planter:  "white terracotta ceramic outdoor planter pot coastal garden porch",
  },
  modern: {
    seating:  "black grey metal outdoor bench chair modern minimalist garden porch contemporary",
    table:    "black metal outdoor side accent table modern minimalist contemporary garden",
    lighting: "modern black outdoor lantern lamp post contemporary garden front porch",
    planter:  "concrete geometric black white outdoor planter pot modern garden",
  },
  bohemian: {
    seating:  "rattan wicker boho outdoor bench chair natural eclectic garden front porch",
    table:    "rattan wood boho outdoor side accent table natural eclectic garden",
    lighting: "rattan woven outdoor hanging lantern boho natural garden porch",
    planter:  "terracotta macrame boho outdoor planter pot eclectic natural garden",
  },
  luxury: {
    seating:  "white teak premium outdoor bench lounge chair luxury garden front porch",
    table:    "white teak marble top outdoor side accent table luxury garden premium",
    lighting: "black gold brass luxury outdoor lantern lamp premium garden porch",
    planter:  "large white ceramic luxury statement outdoor planter garden premium",
  },
};

function getFrontyardSlotQueries(theme: string): FrontyardSlotQueries {
  const lower = theme.toLowerCase();
  if (/coastal|beach|nautical/i.test(lower)) return FRONTYARD_SLOT_QUERIES.coastal;
  if (/boho|bohemian/i.test(lower))          return FRONTYARD_SLOT_QUERIES.bohemian;
  if (/luxury|glam/i.test(lower))            return FRONTYARD_SLOT_QUERIES.luxury;
  return FRONTYARD_SLOT_QUERIES.modern;
}

export async function retrieveFrontyardSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "frontyard";
  const seed = `frontyard|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;
  const q = getFrontyardSlotQueries(theme);

  const [seatingEmb, tableEmb, lightingEmb, planterEmb] = await Promise.all([
    embedQuery(`${theme} ${q.seating}`),
    embedQuery(`${theme} ${q.table}`),
    embedQuery(`${theme} ${q.lighting}`),
    embedQuery(`${theme} ${q.planter}`),
  ]);

  const LIMIT = 25;
  const [seating, tables, lighting, planters] = await Promise.all([
    queryBucketCandidates(seatingEmb,  roomType, { bucket: "seating",  limit: LIMIT, required: true,  allowedCategories: ["outdoor_seating", "bench", "outdoor_chair", "outdoor_sofa"] },  [], minPrice, maxPrice),
    queryBucketCandidates(tableEmb,    roomType, { bucket: "tables",   limit: LIMIT, required: false, allowedCategories: ["outdoor_table", "side_table"] },                                 [], minPrice, maxPrice),
    queryBucketCandidates(lightingEmb, roomType, { bucket: "lighting", limit: LIMIT, required: false, allowedCategories: ["outdoor_lighting", "lamp"] },                                    [], minPrice, maxPrice),
    queryBucketCandidates(planterEmb,  roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["planter", "outdoor_decor", "artificial_plant", "decor"] },       [], minPrice, maxPrice),
  ]);

  return [
    { slot: "seating",  products: rerankBucketItems("seating",  seating,  theme, seed, roomType).slice(0, 12) },
    { slot: "table",    products: rerankBucketItems("tables",   tables,   theme, seed, roomType).slice(0, 12) },
    { slot: "lighting", products: rerankBucketItems("lighting", lighting, theme, seed, roomType).slice(0, 12) },
    { slot: "planter",  products: rerankBucketItems("decor",    planters, theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Backyard per-slot retrieval ──────────────────────────────────────────────

type BackyardSlotQueries = {
  seating: string; table: string; lighting: string; planter: string; fire_pit: string;
};

const BACKYARD_SLOT_QUERIES: Record<string, BackyardSlotQueries> = {
  coastal: {
    seating:  "rattan wicker outdoor sofa sectional set coastal natural garden patio backyard",
    table:    "rattan wicker outdoor coffee dining table coastal natural garden patio",
    lighting: "white string lights solar outdoor lantern coastal natural garden patio",
    planter:  "white terracotta ceramic large outdoor planter pot coastal garden",
    fire_pit: "copper bronze round outdoor fire pit coastal natural garden patio",
  },
  modern: {
    seating:  "black grey modern outdoor sofa sectional dining set contemporary patio garden",
    table:    "concrete black modern outdoor dining coffee table contemporary patio",
    lighting: "modern black outdoor string lights lamp post contemporary garden patio",
    planter:  "concrete geometric modern outdoor large planter garden contemporary",
    fire_pit: "black steel modern outdoor fire pit bowl contemporary garden patio",
  },
  bohemian: {
    seating:  "rattan wicker boho outdoor sofa set eclectic natural garden patio",
    table:    "rattan wood boho outdoor coffee dining table natural eclectic garden",
    lighting: "rattan boho hanging string lights lantern outdoor garden patio eclectic",
    planter:  "terracotta macrame boho large outdoor planter garden eclectic",
    fire_pit: "copper bronze boho outdoor fire pit eclectic natural garden patio",
  },
  luxury: {
    seating:  "white teak luxury outdoor sofa sectional dining set premium patio garden",
    table:    "teak marble white luxury outdoor dining coffee table premium garden",
    lighting: "black gold luxury outdoor string lights lantern premium garden patio",
    planter:  "large white ceramic luxury outdoor planter garden premium statement",
    fire_pit: "black gold luxury premium outdoor fire pit garden patio statement",
  },
};

function getBackyardSlotQueries(theme: string): BackyardSlotQueries {
  const lower = theme.toLowerCase();
  if (/coastal|beach|nautical/i.test(lower)) return BACKYARD_SLOT_QUERIES.coastal;
  if (/boho|bohemian/i.test(lower))          return BACKYARD_SLOT_QUERIES.bohemian;
  if (/luxury|glam/i.test(lower))            return BACKYARD_SLOT_QUERIES.luxury;
  return BACKYARD_SLOT_QUERIES.modern;
}

export async function retrieveBackyardSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "backyard";
  const seed = `backyard|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;
  const q = getBackyardSlotQueries(theme);

  const [seatingEmb, tableEmb, lightingEmb, planterEmb, firePitEmb] = await Promise.all([
    embedQuery(`${theme} ${q.seating}`),
    embedQuery(`${theme} ${q.table}`),
    embedQuery(`${theme} ${q.lighting}`),
    embedQuery(`${theme} ${q.planter}`),
    embedQuery(`${theme} ${q.fire_pit}`),
  ]);

  const LIMIT = 25;
  const [seating, tables, lighting, planters, firePits] = await Promise.all([
    queryBucketCandidates(seatingEmb,  roomType, { bucket: "seating",  limit: LIMIT, required: true,  allowedCategories: ["outdoor_seating", "outdoor_sofa", "outdoor_chair", "bench", "outdoor_lounger"] }, [], minPrice, maxPrice),
    queryBucketCandidates(tableEmb,    roomType, { bucket: "tables",   limit: LIMIT, required: true,  allowedCategories: ["outdoor_table", "outdoor_dining_table", "side_table"] },                           [], minPrice, maxPrice),
    queryBucketCandidates(lightingEmb, roomType, { bucket: "lighting", limit: LIMIT, required: false, allowedCategories: ["outdoor_lighting", "lamp"] },                                                       [], minPrice, maxPrice),
    queryBucketCandidates(planterEmb,  roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["planter", "outdoor_decor", "artificial_plant", "decor"] },                         [], minPrice, maxPrice),
    queryBucketCandidates(firePitEmb,  roomType, { bucket: "decor",    limit: LIMIT, required: false, allowedCategories: ["fire_pit", "outdoor_decor", "decor"] },                                             [], minPrice, maxPrice),
  ]);

  return [
    { slot: "seating",  products: rerankBucketItems("seating",  seating,  theme, seed, roomType).slice(0, 12) },
    { slot: "table",    products: rerankBucketItems("tables",   tables,   theme, seed, roomType).slice(0, 12) },
    { slot: "lighting", products: rerankBucketItems("lighting", lighting, theme, seed, roomType).slice(0, 12) },
    { slot: "planter",  products: rerankBucketItems("decor",    planters, theme, seed, roomType).slice(0, 12) },
    { slot: "fire_pit", products: rerankBucketItems("decor",    firePits, theme, seed, roomType).slice(0, 12) },
  ];
}

export async function retrieveBedroomSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "bedroom";
  const seed = `bedroom|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const q = getBedroomSlotQueries(theme);

  const [bedEmb, nightstandEmb, lampEmb, beddingEmb, dresserEmb] = await Promise.all([
    embedQuery(`${theme} ${q.bed}`),
    embedQuery(`${theme} ${q.nightstand}`),
    embedQuery(`${theme} ${q.lamp}`),
    embedQuery(`${theme} ${q.bedding}`),
    embedQuery(`${theme} ${q.dresser}`),
  ]);

  const LIMIT = 25;

  const [bedsRaw, nightstands, lampsRaw, bedding, dressers] = await Promise.all([
    queryBucketCandidates(bedEmb,       roomType, { bucket: "bed",            limit: LIMIT, required: true,  allowedCategories: ["bed"] },                    [], minPrice, maxPrice),
    queryBucketCandidates(nightstandEmb, roomType, { bucket: "tables",         limit: LIMIT, required: true,  allowedCategories: ["nightstand", "side_table"] }, [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,       roomType, { bucket: "lighting",       limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                    [], minPrice, maxPrice),
    queryBucketCandidates(beddingEmb,    roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["bedding"] },                 [], minPrice, maxPrice),
    queryBucketCandidates(dresserEmb,    roomType, { bucket: "storage",        limit: LIMIT, required: false, allowedCategories: ["dresser", "nightstand"] },    [], minPrice, maxPrice),
  ]);

  const beds = filterBedroomBeds(bedsRaw);
  const lamps = filterBedroomLamps(lampsRaw);
  const dressersFiltered = filterBedroomDressers(dressers);

  return [
    { slot: "bed",       products: rerankBucketItems("bed",            beds,       theme, seed, roomType).slice(0, 12) },
    { slot: "nightstand", products: rerankBucketItems("tables",        nightstands, theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",      products: rerankBucketItems("lighting",       lamps,      theme, seed, roomType).slice(0, 12) },
    { slot: "bedding",   products: rerankBucketItems("soft_furnishing", bedding,    theme, seed, roomType).slice(0, 12) },
    { slot: "dresser",   products: rerankBucketItems("storage",        dressersFiltered, theme, seed, roomType).slice(0, 12) },
  ];
}

function getLivingRoomSlotQueries(theme: string): SlotQueries {
  const lower = theme.toLowerCase();
  if (/scandi|scandinavian|nordic/i.test(lower))         return LIVING_ROOM_SLOT_QUERIES.scandinavian;
  if (/coastal|hampton|nautical|beach/i.test(lower))     return LIVING_ROOM_SLOT_QUERIES.coastal;
  if (/japandi/i.test(lower))                            return LIVING_ROOM_SLOT_QUERIES.japandi;
  if (/boho|bohemian/i.test(lower))                      return LIVING_ROOM_SLOT_QUERIES.boho;
  if (/luxury|glam/i.test(lower))                        return LIVING_ROOM_SLOT_QUERIES.luxury;
  if (/industrial/i.test(lower))                         return LIVING_ROOM_SLOT_QUERIES.industrial;
  if (/farmhouse/i.test(lower))                          return LIVING_ROOM_SLOT_QUERIES.farmhouse;
  if (/mid[\s_-]?century|midcentury/i.test(lower))       return LIVING_ROOM_SLOT_QUERIES.mid_century;
  if (/modern/i.test(lower))                             return LIVING_ROOM_SLOT_QUERIES.modern;
  // Generic fallback for unrecognised themes
  return {
    sofa:         `${theme} 3-seater sofa couch living room`,
    chair:        `${theme} accent armchair living room`,
    coffee_table: `${theme} rectangular coffee table living room`,
    rug:          `${theme} area rug living room`,
    lamp:         `${theme} floor lamp living room`,
  };
}

export async function retrieveLivingRoomSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "living_room";
  const seed = `living_room|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const q = getLivingRoomSlotQueries(theme);

  const [sofaEmb, chairEmb, tableEmb, rugEmb, lampEmb] = await Promise.all([
    embedQuery(`${theme} ${q.sofa}`),
    embedQuery(`${theme} ${q.chair}`),
    embedQuery(`${theme} ${q.coffee_table}`),
    embedQuery(`${theme} ${q.rug}`),
    embedQuery(`${theme} ${q.lamp}`),
  ]);

  const LIMIT = 25;

  const [sofasRaw, chairs, rugs, coffeeTables, lamps] = await Promise.all([
    queryBucketCandidates(sofaEmb,  roomType, { bucket: "seating",         limit: LIMIT, required: true,  allowedCategories: ["sofa"] },         [], minPrice, maxPrice),
    queryBucketCandidates(chairEmb, roomType, { bucket: "seating",         limit: LIMIT, required: true,  allowedCategories: ["accent_chair"] }, [], minPrice, maxPrice),
    queryBucketCandidates(rugEmb,   roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["rug"] },           [], minPrice, maxPrice),
    queryBucketCandidates(tableEmb, roomType, { bucket: "tables",          limit: LIMIT, required: true,  allowedCategories: ["coffee_table"] }, [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,  roomType, { bucket: "lighting",        limit: LIMIT, required: true,  allowedCategories: ["lamp"] },          [], minPrice, maxPrice),
  ]);

  // Exclude sofa beds / sleepers / loveseats / bean bags — wrong form factor for a sofa slot
  const sofas = sofasRaw.filter(p => !/sleeper|sofa.?bed|futon|pull.?out|daybed|loveseat|bean.?bag/i.test(p.title));

  return [
    { slot: "sofa",         products: rerankBucketItems("seating",         sofas,        theme, seed, roomType).slice(0, 12) },
    { slot: "chair",        products: rerankBucketItems("seating",         chairs,       theme, seed, roomType).slice(0, 12) },
    { slot: "rug",          products: rerankBucketItems("soft_furnishing", rugs,         theme, seed, roomType).slice(0, 12) },
    { slot: "coffee_table", products: rerankBucketItems("tables",          coffeeTables, theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",         products: rerankBucketItems("lighting",        lamps,        theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Dining Room per-slot retrieval ─────────────────────────────────────────

export async function retrieveDiningRoomSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "dining_room";
  const seed = `dining_room|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const [diningTableEmb, chairEmb, sideboardEmb, lampEmb, rugEmb] = await Promise.all([
    embedQuery(`${theme} dining table rectangular wood modern`),
    embedQuery(`${theme} dining chair upholstered set`),
    embedQuery(`${theme} sideboard buffet cabinet dining room storage`),
    embedQuery(`${theme} pendant light chandelier dining room lamp`),
    embedQuery(`${theme} area rug dining room under table`),
  ]);

  const LIMIT = 25;
  const [diningTables, chairs, sideboards, lamps, rugs] = await Promise.all([
    queryBucketCandidates(diningTableEmb, roomType, { bucket: "tables",          limit: LIMIT, required: true,  allowedCategories: ["dining_table"] },             [], minPrice, maxPrice),
    queryBucketCandidates(chairEmb,       roomType, { bucket: "seating",         limit: LIMIT, required: true,  allowedCategories: ["dining_chair"] },             [], minPrice, maxPrice),
    queryBucketCandidates(sideboardEmb,   roomType, { bucket: "storage",         limit: LIMIT, required: false, allowedCategories: ["sideboard", "buffet", "cabinet"] }, [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,        roomType, { bucket: "lighting",        limit: LIMIT, required: true,  allowedCategories: ["lamp", "chandelier"] },       [], minPrice, maxPrice),
    queryBucketCandidates(rugEmb,         roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["rug"] },                      [], minPrice, maxPrice),
  ]);

  return [
    { slot: "dining_table", products: rerankBucketItems("tables",          diningTables, theme, seed, roomType).slice(0, 12) },
    { slot: "chair",        products: rerankBucketItems("seating",         chairs,       theme, seed, roomType).slice(0, 12) },
    { slot: "sideboard",    products: rerankBucketItems("storage",         sideboards,   theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",         products: rerankBucketItems("lighting",        lamps,        theme, seed, roomType).slice(0, 12) },
    { slot: "rug",          products: rerankBucketItems("soft_furnishing", rugs,         theme, seed, roomType).slice(0, 12) },
  ];
}

// ─── Office per-slot retrieval ──────────────────────────────────────────────

export async function retrieveOfficeSlots(params: {
  theme: string;
  minPrice?: number | null;
  maxPrice?: number | null;
}): Promise<{ slot: string; products: RetrievedProduct[] }[]> {
  const { theme, minPrice = null, maxPrice = null } = params;
  const roomType: RoomType = "office";
  const seed = `office|${theme.toLowerCase().replace(/\s+/g, "_")}|fixed`;

  const [deskEmb, chairEmb, lampEmb, cabinetEmb, rugEmb] = await Promise.all([
    embedQuery(`${theme} office desk writing desk workstation`),
    embedQuery(`${theme} office chair ergonomic task chair`),
    embedQuery(`${theme} desk lamp table lamp office`),
    embedQuery(`${theme} bookshelf bookcase office storage cabinet`),
    embedQuery(`${theme} area rug office room`),
  ]);

  const LIMIT = 25;
  const [desks, chairs, lamps, cabinets, rugs] = await Promise.all([
    queryBucketCandidates(deskEmb,    roomType, { bucket: "tables",          limit: LIMIT, required: true,  allowedCategories: ["desk", "writing_desk"] },          [], minPrice, maxPrice),
    queryBucketCandidates(chairEmb,   roomType, { bucket: "seating",         limit: LIMIT, required: true,  allowedCategories: ["office_chair", "task_chair"] },    [], minPrice, maxPrice),
    queryBucketCandidates(lampEmb,    roomType, { bucket: "lighting",        limit: LIMIT, required: true,  allowedCategories: ["lamp"] },                          [], minPrice, maxPrice),
    queryBucketCandidates(cabinetEmb, roomType, { bucket: "storage",         limit: LIMIT, required: false, allowedCategories: ["bookshelf", "bookcase", "cabinet"] }, [], minPrice, maxPrice),
    queryBucketCandidates(rugEmb,     roomType, { bucket: "soft_furnishing", limit: LIMIT, required: false, allowedCategories: ["rug"] },                           [], minPrice, maxPrice),
  ]);

  return [
    { slot: "desk",    products: rerankBucketItems("tables",          desks,    theme, seed, roomType).slice(0, 12) },
    { slot: "chair",   products: rerankBucketItems("seating",         chairs,   theme, seed, roomType).slice(0, 12) },
    { slot: "lamp",    products: rerankBucketItems("lighting",        lamps,    theme, seed, roomType).slice(0, 12) },
    { slot: "cabinet", products: rerankBucketItems("storage",         cabinets, theme, seed, roomType).slice(0, 12) },
    { slot: "rug",     products: rerankBucketItems("soft_furnishing", rugs,     theme, seed, roomType).slice(0, 12) },
  ];
}

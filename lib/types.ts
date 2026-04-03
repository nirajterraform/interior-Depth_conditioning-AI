export type RoomType =
  | "living_room" | "bedroom" | "dining_room" | "kitchen" | "office"
  | "loft" | "hallway" | "frontyard" | "backyard" | "kids_room";

export type CatalogueProduct = {
  bucket: string;
  product_handle: string;
  title: string;
  category?: string | null;
  subcategory?: string | null;
  normalized_category?: string | null;
  image_url?: string | null;
  min_price?: number | null;
  max_price?: number | null;
  similarity?: number;
};

export type AuthoritativeProduct = CatalogueProduct & {
  slot: string;
  requestedCategory: string;
  confidence: number;
};

export type PipelineStage =
  | "idle" | "detecting" | "removing" | "retrieving"
  | "ready" | "placing" | "coherence" | "done" | "error";

export type FalImage = {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
};

// Alias kept for retrieval.ts compatibility
export type RetrievedProduct = CatalogueProduct;

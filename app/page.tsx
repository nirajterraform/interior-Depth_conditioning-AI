"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RoomType = "living_room" | "bedroom" | "dining_room" | "kitchen" | "office" | "loft" | "hallway" | "frontyard" | "backyard" | "kids_room";
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

type Stage = "idle" | "detecting" | "retrieving" | "generating" | "ready" | "done" | "error";

const THEMES = [
  { id: "scandi", label: "Scandi" },
  { id: "japandi", label: "Japandi" },
  { id: "coastal", label: "Coastal" },
  { id: "luxury", label: "Luxury" },
  { id: "industrial", label: "Industrial" },
  { id: "bohemian", label: "Boho" },
  { id: "mid_century", label: "Mid-Century" },
  { id: "modern", label: "Modern" },
];

const ROOM_LABELS: Record<RoomType, string> = {
  living_room: "Living Room",
  bedroom: "Bedroom",
  dining_room: "Dining Room",
  kitchen: "Kitchen",
  office: "Office",
  loft: "Loft / Foyer",
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

  const [products, setProducts] = useState<Product[]>([]);
  // pages: Map of pageNumber (1-based) → product list for that page
  const [morePages, setMorePages] = useState<Map<number, Product[]>>(new Map());
  const [currentMorePage, setCurrentMorePage] = useState<number | null>(null);
  const [totalMorePages, setTotalMorePages] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rotationCursor, setRotationCursor] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [placedProducts, setPlacedProducts] = useState<PlacedProduct[]>([]);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [inventedItemCrops, setInventedItemCrops] = useState<InventedItemCrop[]>([]);

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
  const busy = stage === "detecting" || stage === "retrieving" || stage === "generating";

  // Auto-load the first "More Matches" page as soon as generation completes
  // so the section is never blank when the user scrolls down.
  useEffect(() => {
    if (stage === "done" && currentMorePage === null && !loadingMore) {
      goToMorePage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const selectedProducts = useMemo(
    () => products.filter((p) => selected.has(p.product_handle) && hasValidImage(p)),
    [products, selected]
  );

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
    }
  }, [generatedImage, editInstruction, effectiveRoom, effectiveTheme, pushHistory]);

  const tryInRoom = useCallback(async (product: Product) => {
    if (!generatedImage || !effectiveRoom) return;
    setSwappingHandle(product.product_handle);
    setEditError("");
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

  const retrieveCatalogue = useCallback(async () => {
    if (!effectiveRoom) return;
    setStage("retrieving");
    setStageMsg("Retrieving catalogue products…");
    setError("");
    setGeneratedImage(null);
    setPlacedProducts([]);
    setValidation(null);
    setInventedItemCrops([]);
    setEditInstruction("");
    setEditError("");
    setImageHistory([]);
    setHistoryIndex(-1);
    setMorePages(new Map());
    setCurrentMorePage(null);
    setTotalMorePages(0);
    setRotationCursor(0);
    setValidationRejected(false);

    try {
      const res = await fetch("/api/retrieve-catalogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomType: effectiveRoom, theme: effectiveTheme, pageSize: 12, rotationCursor: 0 }),
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
      setStage("ready");
      setStageMsg("");
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Catalogue retrieval failed.");
      setStageMsg("");
    }
  }, [effectiveRoom, effectiveTheme]);

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

  const generateRoom = useCallback(async () => {
    if (!originalImage || !effectiveRoom || selectedProducts.length === 0) return;

    setStage("generating");
    setStageMsg("Generating room with depth-conditioned editing…");
    setError("");
    setGeneratedImage(null);
    setImageHistory([]);
    setHistoryIndex(-1);
    setEditInstruction("");
    setEditError("");
    setPlacedProducts([]);
    setValidation(null);
    setInventedItemCrops([]);
    setValidationRejected(false);

    try {
      const res = await fetch("/api/fal-place-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalImage,
          mimeType,
          theme: effectiveTheme,
          roomType: effectiveRoom,
          products: selectedProducts.slice(0, 8).map((p) => ({
            title: p.title,
            category: p.normalized_category || p.category || "furniture",
            imageUrl: p.image_url,
            productHandle: p.product_handle,
          })),
        }),
      });

      const data = await res.json();

      if (data.generatedImage) {
        // Seed the history with the first generation
        setImageHistory([data.generatedImage]);
        setHistoryIndex(0);
        setGeneratedImage(data.generatedImage);
      }
      if (data.placedProducts) {
        setPlacedProducts(data.placedProducts);
      }
      if (data.validation) {
        setValidation(data.validation);
      }
      // inventedItemCrops is a top-level field in the API response, not nested in validation
      if (Array.isArray(data.inventedItemCrops)) {
        setInventedItemCrops(data.inventedItemCrops);
      }

      if (!data.ok) {
        // Validation rejected all attempts — show best-effort image with warning
        setValidationRejected(true);
        setError(data.error || "Generation failed validation.");
        setStage("done"); // still "done" so results are visible
      } else {
        setValidationRejected(false);
        setStage("done");
        setStageMsg("");
      }
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Generation failed.");
      setStageMsg("");
    }
  }, [effectiveRoom, effectiveTheme, mimeType, originalImage, selectedProducts]);

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
        <div style={{ fontSize: 13, opacity: 0.9 }}>
          {stageMsg || (stage === "done" ? (validationRejected ? "Best-effort shown (rejected)" : "Accepted") : "")}
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
            {THEMES.map((item) => {
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

          <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
            <button
              disabled={!effectiveRoom || busy}
              onClick={retrieveCatalogue}
              style={{
                borderRadius: 12, background: "#111827", color: "white", border: 0,
                padding: "12px 14px", cursor: effectiveRoom && !busy ? "pointer" : "not-allowed",
                opacity: effectiveRoom && !busy ? 1 : 0.5, fontWeight: 600,
              }}
            >
              Search catalogue
            </button>

            <button
              disabled={!originalImage || selectedProducts.length === 0 || !effectiveRoom || busy}
              onClick={generateRoom}
              style={{
                borderRadius: 12, background: "#2563eb", color: "white", border: 0,
                padding: "12px 14px", fontWeight: 700,
                cursor: !originalImage || selectedProducts.length === 0 || !effectiveRoom || busy ? "not-allowed" : "pointer",
                opacity: !originalImage || selectedProducts.length === 0 || !effectiveRoom || busy ? 0.5 : 1,
              }}
            >
              Generate room
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

          {products.length > 0 && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 18, marginBottom: 10 }}>
                3. Select up to 8 products
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {products.map((product) => {
                  const active = selected.has(product.product_handle);
                  return (
                    <button
                      key={product.product_handle}
                      onClick={() => toggleProduct(product.product_handle)}
                      style={{
                        display: "grid", gridTemplateColumns: "72px 1fr", gap: 10,
                        textAlign: "left", borderRadius: 12,
                        border: active ? "2px solid #2563eb" : "1px solid #e5e7eb",
                        background: active ? "#eff6ff" : "white",
                        padding: 10, cursor: "pointer",
                      }}
                    >
                      <img
                        src={product.image_url || ""}
                        alt={product.title}
                        style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10 }}
                      />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{product.title}</div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
                          {product.normalized_category || product.category || "furniture"}
                        </div>
                        <div style={{ fontSize: 11, color: "#374151", marginTop: 4 }}>
                          {formatPrice(product.min_price, product.max_price)}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
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
                <div style={{ fontSize: 14, fontWeight: 700 }}>Generated room</div>
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
                  {stage === "generating" ? "Generating…" : "The validated output will appear here."}
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
                    Geometry ≥ {88}% · Catalogue avg ≥ {82}% · Zero hallucination
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
                  { label: "Geometry", value: `${validation.geometryScore}%`, ok: validation.geometryScore >= 88 },
                  { label: "Catalogue avg", value: `${validation.catalogueAverageScore}%`, ok: validation.catalogueAverageScore >= 82 },
                  { label: "Hallucination", value: validation.hallucinationDetected ? "Detected" : "Blocked", ok: !validation.hallucinationDetected },
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
                        {cropUrl ? (
                          <img
                            src={cropUrl}
                            alt={`AI invented: ${itemName}`}
                            style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                          />
                        ) : (
                          <div style={{
                            height: 120, display: "grid", placeItems: "center",
                            background: "#fef3c7", fontSize: 36, color: "#f59e0b",
                          }}>
                            ?
                          </div>
                        )}
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
               Paginated browse-only panel. Never touches generated image
               or validation. Each page shows 12 fresh products for the
               same room × theme. Pages are cached after first fetch. */}
          {stage === "done" && (
            <section id="more-matches" style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>
                    More Matches
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    Browse more {effectiveRoom ? ROOM_LABELS[effectiveRoom] : "room"} products for your {effectiveTheme} theme
                  </div>
                </div>
              </div>

              {/* Page tabs */}
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

              {/* Product grid for current page */}
              {currentMorePage !== null && (morePages.get(currentMorePage) ?? []).length > 0 && (
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
              {currentMorePage === null && !loadingMore && (
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

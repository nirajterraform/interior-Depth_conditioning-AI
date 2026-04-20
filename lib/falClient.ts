import { fal } from "@fal-ai/client";

fal.config({
  credentials: process.env.FAL_KEY,
});

export { fal };

/** Upload a base64 data URI to fal.ai storage → returns CDN URL */
export async function uploadToFal(dataUri: string, filename = "image.jpg"): Promise<string> {
  const [header, base64] = dataUri.split(",");
  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch?.[1] ?? "image/jpeg";
  const buffer = Buffer.from(base64, "base64");
  const file = new File([buffer], filename, { type: mimeType });
  return await fal.storage.upload(file);
}

/** Extract first image URL from a fal.ai result */
export function extractFalImageUrl(result: any): string {
  const images = result?.data?.images ?? result?.images ?? [];
  if (!images.length) throw new Error("fal.ai returned no images");
  return images[0].url as string;
}

/** Fetch a fal.ai CDN URL and return it as a base64 data URI */
export async function falUrlToDataUri(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Failed to fetch fal image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "image/png";
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

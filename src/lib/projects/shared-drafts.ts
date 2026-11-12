export const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export type SharedDraft = {
  id: string;
  topic: string;
  brandName: string;
  status: string;
  createdAt: number;
  aspectRatio: AspectRatio;
};

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === "string" && ASPECT_RATIOS.some((ratio) => ratio === value);
}

export function mapSharedDrafts(
  entries: readonly { id: string; data: () => Record<string, unknown> }[],
): SharedDraft[] {
  return entries.map((entry) => {
    const data = entry.data();
    return {
      id: typeof data.id === "string" ? data.id : entry.id,
      topic: typeof data.topic === "string" ? data.topic : "Untitled Video",
      brandName: typeof data.brandName === "string" ? data.brandName : "CreatorOS Edit",
      status: typeof data.status === "string" ? data.status : "in_progress",
      createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
      aspectRatio: isAspectRatio(data.aspectRatio) ? data.aspectRatio : "9:16",
    };
  }).sort((first, second) => second.createdAt - first.createdAt);
}

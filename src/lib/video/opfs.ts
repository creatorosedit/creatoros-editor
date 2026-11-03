// OPFS Helper for storing videos locally

export async function saveVideoToOPFS(draftId: string, file: File) {
  try {
      const root = await navigator.storage.getDirectory();
          const draftsDir = await root.getDirectoryHandle("drafts", { create: true });
              const draftDir = await draftsDir.getDirectoryHandle(draftId, { create: true });
                  const fileHandle = await draftDir.getFileHandle("video.mp4", { create: true });
                      
                          const writable = await fileHandle.createWritable();
                              await writable.write(file);
                                  await writable.close();
                                      
                                          return true;
                                            } catch (error) {
                                                console.error("OPFS Save Error:", error);
                                                    return false;
                                                      }
                                                      }

export async function saveAssetToOPFS(draftId: string, assetId: string, file: File): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const draftsDir = await root.getDirectoryHandle("drafts", { create: true });
  const draftDir = await draftsDir.getDirectoryHandle(draftId, { create: true });
  const assetsDir = await draftDir.getDirectoryHandle("assets", { create: true });
  const assetDir = await assetsDir.getDirectoryHandle(assetId, { create: true });
  const fileHandle = await assetDir.getFileHandle("asset", { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(file);
  } catch (error: unknown) {
    await writable.abort();
    throw error;
  }
  await writable.close();
}

                                                      export async function getVideoFromOPFS(draftId: string): Promise<File | null> {
                                                        try {
                                                            const root = await navigator.storage.getDirectory();
                                                                const draftsDir = await root.getDirectoryHandle("drafts");
                                                                    const draftDir = await draftsDir.getDirectoryHandle(draftId);
                                                                        const fileHandle = await draftDir.getFileHandle("video.mp4");
                                                                            
                                                                                return await fileHandle.getFile();
                                                                                  } catch (error) {
                                                                                      if (error instanceof DOMException && error.name === "NotFoundError") {
                                                                                        return null;
                                                                                      }
                                                                                      throw error;
                                                                                                                    }
                                                                                            }

                                                                                            export async function deleteVideoFromOPFS(draftId: string) {
                                                                                              try {
                                                                                                  const root = await navigator.storage.getDirectory();
                                                                                                      const draftsDir = await root.getDirectoryHandle("drafts");
                                                                                                          await draftsDir.removeEntry(draftId, { recursive: true });
                                                                                                            } catch (error) {
                                                                                                                console.error("OPFS Delete Error:", error);
                                                                                                                  }
                                                                                                                  }
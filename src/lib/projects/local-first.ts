export async function persistLocalFirstProject(
  saveMediaLocally: () => Promise<boolean>,
  saveSharedMetadata: () => Promise<void>,
): Promise<void> {
  if (!await saveMediaLocally()) {
    throw new Error("Could not save this video to local storage.");
  }
  await saveSharedMetadata();
}

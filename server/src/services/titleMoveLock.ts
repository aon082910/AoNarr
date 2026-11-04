/**
 * Which titles are being moved to another root folder right now (a title's "Move files" and a root folder's move
 * both take it). A title in the set must not be renamed, re-foldered or moved a second time at the same moment: two
 * copies of one folder racing each other can delete each other's finished copy. In memory on purpose: a restart
 * ends every move, and a move that was cut off is simply run again.
 */
const movingTitles = new Set<number>();

export function isTitleMoving(itemId: number): boolean {
  return movingTitles.has(Number(itemId));
}

/** Takes the lock for a title; false when somebody holds it already. */
export function tryLockTitleMove(itemId: number): boolean {
  const id = Number(itemId);
  if (movingTitles.has(id)) return false;
  movingTitles.add(id);
  return true;
}

export function unlockTitleMove(itemId: number): void {
  movingTitles.delete(Number(itemId));
}

/** Test-only: forget every lock. */
export function resetTitleMoveLocksForTests(): void {
  movingTitles.clear();
}

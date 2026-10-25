import {
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';

/**
 * Keyboard dragging between columns (dnd-kit keyboard sensor, FRONTEND
 * §9.2): ←/→ move the lifted card over the previous/next column. There is
 * no manual order inside a column (T314: nothing stores it in S3), so ↑/↓
 * do nothing.
 */
export const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') {
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') event.preventDefault();
    return undefined;
  }
  event.preventDefault();
  const { active, collisionRect, droppableRects, droppableContainers } = context;
  if (active === null || collisionRect === null) return undefined;
  const ordered = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = droppableRects.get(container.id);
      return rect === undefined ? [] : [{ id: container.id, rect }];
    })
    .sort((a, b) => a.rect.left - b.rect.left);
  // The column under the lifted card now (`over` lags behind quick key presses).
  const center = collisionRect.left + collisionRect.width / 2;
  const right = event.code === 'ArrowRight';
  const index = ordered.findIndex(({ rect }) => rect.left <= center && center <= rect.right);
  const next =
    index === -1
      ? right
        ? ordered.find(({ rect }) => rect.left > center)
        : ordered.findLast(({ rect }) => rect.right < center)
      : ordered[index + (right ? 1 : -1)];
  if (next === undefined) return undefined;
  return {
    x: next.rect.left + Math.max(0, (next.rect.width - collisionRect.width) / 2),
    y: collisionRect.top,
  };
};

/** The column under the pointer; with the keyboard, the column the lifted card overlaps most. */
export const columnCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

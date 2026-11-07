import { Vector3 } from 'three';
export const OVERVIEW_DIRECTION = new Vector3(.12, .42, 1).normalize();

/** Fit every card face and its hover clearance in the camera's actual perspective. */
export function fitOverview(points: readonly { x: number; z: number }[], aspect: number) {
  if (!points.length) return { center: new Vector3(0, 150, 0), distance: 1900 };
  const minX = Math.min(...points.map((point) => point.x - 230));
  const maxX = Math.max(...points.map((point) => point.x + 230));
  const minZ = Math.min(...points.map((point) => point.z));
  const maxZ = Math.max(...points.map((point) => point.z));
  const center = new Vector3((minX + maxX) / 2, 265, (minZ + maxZ) / 2);
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), OVERVIEW_DIRECTION).normalize();
  const up = new Vector3().crossVectors(OVERVIEW_DIRECTION, right).normalize();
  const tanY = Math.tan(40 * Math.PI / 360) * .84;
  const tanX = tanY * Math.max(.1, aspect);
  let distance = 1900;
  for (const point of points) {
    for (const x of [point.x - 230, point.x + 230]) {
      for (const y of [0, 530]) {
        const relative = new Vector3(x, y, point.z).sub(center);
        const depth = relative.dot(OVERVIEW_DIRECTION);
        distance = Math.max(distance, depth + Math.abs(relative.dot(right)) / tanX,
          depth + Math.abs(relative.dot(up)) / tanY);
      }
    }
  }
  return { center, distance };
}

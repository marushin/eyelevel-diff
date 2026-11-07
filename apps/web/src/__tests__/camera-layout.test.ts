import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { fitOverview, OVERVIEW_DIRECTION } from '../camera-layout.ts';
import { createSiteFixture } from '../data.ts';
import { layoutStacks } from '../stack-layout.ts';

describe('whole-scene camera framing', () => {
  it.each([.5, 1, 1.8])('fits both trunk and branch faces at aspect %s', (aspect) => {
    const points = [...layoutStacks(createSiteFixture({ query: '나비', seed: 4201 })).values()];
    const frame = fitOverview(points, aspect);
    const camera = new PerspectiveCamera(40, aspect, 1, 30000);
    camera.position.copy(frame.center).addScaledVector(OVERVIEW_DIRECTION, frame.distance);
    camera.lookAt(frame.center); camera.updateMatrixWorld();
    for (const point of points) {
      for (const x of [point.x - 230, point.x + 230]) {
        for (const y of [0, 530]) {
          const screen = new Vector3(x, y, point.z).project(camera);
          expect(Math.abs(screen.x)).toBeLessThanOrEqual(.841);
          expect(Math.abs(screen.y)).toBeLessThanOrEqual(.841);
        }
      }
    }
    expect(frame.center.distanceTo(new Vector3(points.at(-1)!.x, 150, points.at(-1)!.z))).toBeGreaterThan(300);
  });
});

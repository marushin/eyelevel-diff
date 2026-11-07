declare module 'd3-force-3d' {
  export interface ForceNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface ForceLinkDatum<N extends ForceNodeDatum = ForceNodeDatum> {
    source: string | number | N;
    target: string | number | N;
    index?: number;
  }

  export interface Force<N extends ForceNodeDatum = ForceNodeDatum> {
    (alpha: number): void;
    initialize?(nodes: N[], random: () => number, numDimensions: number): void;
  }

  export interface Simulation<N extends ForceNodeDatum = ForceNodeDatum> {
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    numDimensions(): 1 | 2 | 3;
    numDimensions(dim: 1 | 2 | 3): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    force<F extends Force<N> = Force<N>>(name: string): F | undefined;
    force(name: string, force: Force<N> | null): this;
    find(x: number, y?: number, z?: number, radius?: number): N | undefined;
    on(typenames: string, listener: ((this: this) => void) | null): this;
  }

  export interface LinkForce<
    N extends ForceNodeDatum = ForceNodeDatum,
    L extends ForceLinkDatum<N> = ForceLinkDatum<N>,
  > extends Force<N> {
    links(): L[];
    links(links: L[]): this;
    id(idAccessor: (node: N, i: number, nodes: N[]) => string | number): this;
    distance(dist: number | ((link: L, i: number, links: L[]) => number)): this;
    strength(str: number | ((link: L, i: number, links: L[]) => number)): this;
    iterations(iter: number): this;
  }

  export interface ManyBodyForce<N extends ForceNodeDatum = ForceNodeDatum> extends Force<N> {
    strength(str: number | ((node: N, i: number, nodes: N[]) => number)): this;
    distanceMin(dist: number): this;
    distanceMax(dist: number): this;
    theta(theta: number): this;
  }

  export interface CollideForce<N extends ForceNodeDatum = ForceNodeDatum> extends Force<N> {
    radius(rad: number | ((node: N, i: number, nodes: N[]) => number)): this;
    strength(str: number): this;
    iterations(iter: number): this;
  }

  export interface RadialForce<N extends ForceNodeDatum = ForceNodeDatum> extends Force<N> {
    radius(rad: number | ((node: N, i: number, nodes: N[]) => number)): this;
    strength(str: number | ((node: N, i: number, nodes: N[]) => number)): this;
    x(x: number): this;
    y(y: number): this;
    z(z: number): this;
  }

  export interface CenterForce<N extends ForceNodeDatum = ForceNodeDatum> extends Force<N> {
    x(x: number): this;
    y(y: number): this;
    z(z: number): this;
    strength(str: number): this;
  }

  export function forceSimulation<N extends ForceNodeDatum = ForceNodeDatum>(
    nodes?: N[],
    numDimensions?: 1 | 2 | 3,
  ): Simulation<N>;

  export function forceLink<
    N extends ForceNodeDatum = ForceNodeDatum,
    L extends ForceLinkDatum<N> = ForceLinkDatum<N>,
  >(links?: L[]): LinkForce<N, L>;

  export function forceManyBody<N extends ForceNodeDatum = ForceNodeDatum>(): ManyBodyForce<N>;

  export function forceCollide<N extends ForceNodeDatum = ForceNodeDatum>(
    radius?: number | ((node: N, i: number, nodes: N[]) => number),
  ): CollideForce<N>;

  export function forceRadial<N extends ForceNodeDatum = ForceNodeDatum>(
    radius: number | ((node: N, i: number, nodes: N[]) => number),
    x?: number,
    y?: number,
    z?: number,
  ): RadialForce<N>;

  export function forceCenter<N extends ForceNodeDatum = ForceNodeDatum>(
    x?: number,
    y?: number,
    z?: number,
  ): CenterForce<N>;
}

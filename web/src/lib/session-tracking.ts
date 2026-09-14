/** API response details. The Rust collector validates incoming activity. */
export type ActivityDetails = {
  clientTime?: number;
  sequence?: number;
  target?: string;
  destination?: string;
  scrollDepth?: number;
  activeSeconds?: number;
  x?: number;
  y?: number;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  language: string;
};

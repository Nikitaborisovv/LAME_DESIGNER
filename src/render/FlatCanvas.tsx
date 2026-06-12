import { Canvas } from "@react-three/fiber";
import type { CompositeBlend, SceneConfig } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { PeopleApi } from "../ml/usePeople";
import type { SegmentationApi } from "../ml/useSegmentation";
import type { SplatApi } from "../ui/SplatMask";
import { FlatView, type FxDriverRefs } from "./FlatView";
import { FpsLimiter } from "./FpsLimiter";

interface Props {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  fit?: "cover" | "contain";
  zIndex: number;
  blendMode?: CompositeBlend; // T3 Composite: CSS mix-blend-mode при composite (flatOver)
  overlay?: boolean; // верхний слой над 3D: видео скрыто, только эффекты (прозрачный)
  depth?: DepthApi;
  people?: PeopleApi;
  seg?: SegmentationApi;
  splat?: SplatApi;
  fxDrivers?: FxDriverRefs; // direction A: сигналы для биндабельных params shader-FX
}

export function FlatCanvas({ video, config, fit = "cover", zIndex, blendMode, overlay, depth, people, seg, splat, fxDrivers }: Props) {
  return (
    <Canvas
      frameloop="demand"
      orthographic
      camera={{ position: [0, 0, 2], zoom: 1 }}
      gl={{ antialias: true, alpha: true }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex,
        mixBlendMode: blendMode ?? "normal",
        background: overlay ? "transparent" : "#06080c",
        pointerEvents: "none",
      }}
    >
      <FpsLimiter fps={config.fpsCap} />
      <FlatView video={video} config={config} fit={fit} transparentVideo={overlay} depth={depth} people={people} seg={seg} splat={splat} fxDrivers={fxDrivers} />
    </Canvas>
  );
}

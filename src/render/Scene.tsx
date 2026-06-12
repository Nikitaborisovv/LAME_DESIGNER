import type * as THREE from "three";
import type { CompositeBlend, CompositeOrder, SceneConfig } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { PeopleApi } from "../ml/usePeople";
import type { SegmentationApi } from "../ml/useSegmentation";
import type { SplatApi } from "../ui/SplatMask";
import type { FxDriverRefs } from "./FlatView";
import { CloudCanvas } from "./CloudCanvas";
import { FlatCanvas } from "./FlatCanvas";

interface Props {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  depth: DepthApi;
  people: PeopleApi;
  seg: SegmentationApi;
  splat: SplatApi;
  scanRef: React.MutableRefObject<number>;
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  fxDrivers?: FxDriverRefs; // direction A: сигналы для биндабельных params shader-FX
}

// T3 Composite (canvas-level): раскладка двух канвасов-сиблингов (flat = 2D-сцена, cloud = 3D-облако)
// при активном composite. ЧИСТАЯ функция (юнит-тестируется) — решает z-порядок, режим смешивания
// CSS mix-blend-mode на ВЕРХНЕМ канвасе и прозрачность облака. Раньше порядок был захардкожен
// (облако над flat) — это и была жалоба #3. blend применяется к верхнему; нижний — непрозрачный фон.
export interface CanvasLayout {
  zIndex: number;
  blendMode: CompositeBlend; // CSS mix-blend-mode ("normal" = просто перекрытие)
}
export function compositeLayout(order: CompositeOrder, blend: CompositeBlend): {
  flat: CanvasLayout;
  cloud: CanvasLayout & { transparent: boolean };
} {
  if (order === "flatOver") {
    // Облако снизу непрозрачным фоном, 2D-сцена сверху смешивается с ним.
    return {
      cloud: { zIndex: 0, blendMode: "normal", transparent: false },
      flat: { zIndex: 1, blendMode: blend },
    };
  }
  // cloudOver (дефолт = прежнее поведение): flat снизу, облако сверху прозрачным, blend на облаке.
  return {
    flat: { zIndex: 0, blendMode: "normal" },
    cloud: { zIndex: 1, blendMode: blend, transparent: true },
  };
}

// Компоновщик слоёв сцены.
//  - flat:            один слой 2D-эффектов.
//  - cloud:           один слой 3D-облака.
//  - cloud+composite: 2D-сцена и 3D-облако на двух канвасах; порядок (что-над-чем) и режим
//                     смешивания задаются compositeOrder/compositeBlend (нода Композит / ScenePanel),
//                     а НЕ захардкожены -> оверлеи (App) поверх.
export function Scene({ video, config, depth, people, seg, splat, scanRef, cameraRef, fxDrivers }: Props) {
  const flat = config.renderMode === "flat";
  const composite = !flat && config.composite;

  if (flat) {
    // contain: видео целиком влезает во вьюпорт (зум колёсиком приближает/отдаляет).
    return <FlatCanvas video={video} config={config} fit="contain" zIndex={1} depth={depth} people={people} seg={seg} splat={splat} fxDrivers={fxDrivers} />;
  }

  if (!composite) {
    // Только облако (нет активных 2D-слоёв) — непрозрачный полноэкранный канвас, как прежде.
    return (
      <CloudCanvas video={video} config={config} depth={depth} scanRef={scanRef} cameraRef={cameraRef} zIndex={1} transparent={false} />
    );
  }

  const lay = compositeLayout(config.compositeOrder, config.compositeBlend);
  return (
    <>
      <FlatCanvas video={video} config={config} fit="contain" zIndex={lay.flat.zIndex} blendMode={lay.flat.blendMode} depth={depth} people={people} seg={seg} splat={splat} fxDrivers={fxDrivers} />
      <CloudCanvas video={video} config={config} depth={depth} scanRef={scanRef} cameraRef={cameraRef} zIndex={lay.cloud.zIndex} blendMode={lay.cloud.blendMode} transparent={lay.cloud.transparent} />
    </>
  );
}

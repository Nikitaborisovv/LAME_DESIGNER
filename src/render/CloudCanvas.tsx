import { useEffect } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { CompositeBlend, SceneConfig } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import { PointCloud } from "./PointCloud";
import { ScanAscii3D } from "./ScanAscii3D";
import { FpsLimiter } from "./FpsLimiter";

// Ортокамера под облако: contain-фит под аспект видео; frontLock=true -> строго фронтально
// с ПРОТИВОПОЛОЖНОЙ стороны (−Z), точный оверлей на кадр.
function CloudCamera({ video, frontLock, cameraRef }: {
  video: HTMLVideoElement | null;
  frontLock: boolean;
  cameraRef?: React.MutableRefObject<THREE.Camera | null>;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  // U1: при анмаунте облака сбрасываем cameraRef в null — иначе always-on потребитель (ModifierOverlay)
  // проецировал бы 3D-точки через ЗАМОРОЖЕННУЮ последнюю cloud-камеру после cloud→flat, вместо
  // fakePerspective-фолбэка (config-reviewer). До U1 единственный потребитель (Constellation3D) жил
  // только при cloud, поэтому стейл был недостижим.
  useEffect(() => () => { if (cameraRef) cameraRef.current = null; }, [cameraRef]);
  useFrame(() => {
    if (cameraRef) cameraRef.current = camera;
    const cam = camera as THREE.OrthographicCamera;
    if (!(cam as any).isOrthographicCamera) return;
    const va = (video && video.videoWidth / video.videoHeight) || 16 / 9;
    const ca = size.width / size.height;
    let hx: number, hy: number;
    if (ca >= va) { hy = 1; hx = ca; } else { hx = va; hy = va / ca; }
    cam.left = -hx; cam.right = hx; cam.top = hy; cam.bottom = -hy;
    if (frontLock) {
      cam.position.set(0, 0, -8);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      cam.zoom = 1;
    }
    cam.updateProjectionMatrix();
  });
  return null;
}

interface Props {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  depth: DepthApi;
  scanRef?: React.MutableRefObject<number>;
  cameraRef?: React.MutableRefObject<THREE.Camera | null>;
  zIndex: number;
  transparent?: boolean;
  blendMode?: CompositeBlend; // T3 Composite: CSS mix-blend-mode при composite (cloudOver)
}

export function CloudCanvas({ video, config, depth, scanRef, cameraRef, zIndex, transparent, blendMode }: Props) {
  return (
    <Canvas
      frameloop="demand"
      orthographic
      camera={{ position: [0, 0, -8], zoom: 1, near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true }}
      style={{ position: "absolute", inset: 0, zIndex, mixBlendMode: blendMode ?? "normal", background: transparent ? "transparent" : "#06080c" }}
    >
      <FpsLimiter fps={config.fpsCap} />
      <PointCloud video={video} config={config} depth={depth} scanRef={scanRef} />
      {config.scanAsciiEnabled && scanRef && (
        <ScanAscii3D video={video} config={config} depth={depth} scanRef={scanRef} />
      )}
      <CloudCamera video={video} frontLock={config.frontLock} cameraRef={cameraRef} />
      <OrbitControls makeDefault enabled={!config.frontLock} enableDamping dampingFactor={0.08} />
    </Canvas>
  );
}

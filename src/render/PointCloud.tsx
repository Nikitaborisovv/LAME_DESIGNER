import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneConfig } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import { scanVertex, scanFragment } from "./scanShader";

interface Props {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  depth: DepthApi;
  scanRef?: React.MutableRefObject<number>;
}

const TARGET_POINTS = 57600; // ~320x180; распределяем под аспект кадра

export function PointCloud({ video, config, depth, scanRef }: Props) {
  const { submit, latestRef, smoothedRef, getCached } = depth;
  const frameCount = useRef(0);
  const scan = useRef(0);
  const [aspect, setAspect] = useState(16 / 9);

  // Сетка нормирована [-1,1]; плотность по осям — под аспект (равномерный шаг).
  const geometry = useMemo(() => {
    const cols = Math.max(2, Math.round(Math.sqrt(TARGET_POINTS * aspect)));
    const rows = Math.max(2, Math.round(TARGET_POINTS / cols));
    const positions = new Float32Array(cols * rows * 3);
    let i = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        positions[i++] = (x / (cols - 1)) * 2 - 1;
        positions[i++] = (y / (rows - 1)) * 2 - 1;
        positions[i++] = 0;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [aspect]);

  const depthTex = useRef(
    new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType)
  );

  const colorTex = useMemo(() => {
    if (!video) return null;
    const t = new THREE.VideoTexture(video);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // выровнять с картой глубины
    return t;
  }, [video]);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: scanVertex,
      fragmentShader: scanFragment,
      uniforms: {
        uDepth: { value: depthTex.current },
        uColor: { value: colorTex },
        uDepthScale: { value: config.depthScale },
        uPointSize: { value: config.pointSize },
        uScan: { value: 0 },
        uScanWidth: { value: config.scanWidth },
        uScanEnabled: { value: config.scanEnabled ? 1 : 0 },
        uScanColor: { value: new THREE.Color(config.scanColor) },
        uScanColor2: { value: new THREE.Color(config.scanColor2) },
        uScanColor3: { value: new THREE.Color(config.scanColor3) },
        uScanGradient: { value: 0 },
        uScanHide: { value: 0 },
        uScanOnly: { value: 0 },
        uNoiseScale: { value: config.scanNoiseScale },
        uNoiseAmount: { value: config.scanNoiseAmount },
        uSquare: { value: 0 },
        uAspect: { value: aspect },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorTex]);

  // Освобождение GPU-ресурсов: каждый useMemo диспозит СВОЁ предыдущее значение при смене
  // зависимости и при размонтировании (иначе утечка на смене источника/аспекта и flat<->cloud).
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => { colorTex?.dispose(); }, [colorTex]);
  useEffect(() => () => material.dispose(), [material]);
  // Текстура глубины живёт в ref (заменяется в uploadDepth) — чистим финальную на анмаунте.
  useEffect(() => () => { depthTex.current.dispose(); }, []);

  function uploadDepth(frame: { data: Uint8Array; width: number; height: number } | null) {
    if (!frame) return;
    const img = depthTex.current.image;
    if (frame.width === img.width && frame.height === img.height && img.data === frame.data) return;
    const tex = new THREE.DataTexture(
      frame.data, frame.width, frame.height, THREE.RedFormat, THREE.UnsignedByteType
    );
    tex.needsUpdate = true;
    depthTex.current.dispose();
    depthTex.current = tex;
    material.uniforms.uDepth.value = tex;
  }

  useFrame((_, delta) => {
    if (!video) return;
    frameCount.current++;

    const va = video.videoWidth / video.videoHeight;
    if (va && Math.abs(va - aspect) > 0.01) setAspect(va);

    const useCache = config.cacheEnabled && depth.hasCache();
    if (useCache) {
      uploadDepth(getCached(video.currentTime));
    } else {
      if (config.depthEnabled && frameCount.current % config.depthEveryNthFrame === 0) {
        submit(video);
      }
      uploadDepth(smoothedRef.current ?? latestRef.current);
    }

    scan.current = (scan.current + delta * config.scanSpeed) % 1;
    if (scanRef) scanRef.current = scan.current;
    const u = material.uniforms;
    u.uScan.value = scan.current;
    u.uDepthScale.value = config.depthScale;
    u.uPointSize.value = config.pointSize;
    u.uScanWidth.value = config.scanWidth;
    u.uScanEnabled.value = config.scanEnabled ? 1 : 0;
    (u.uScanColor.value as THREE.Color).set(config.scanColor);
    (u.uScanColor2.value as THREE.Color).set(config.scanColor2);
    (u.uScanColor3.value as THREE.Color).set(config.scanColor3);
    u.uScanGradient.value = config.scanGradient ? 1 : 0;
    u.uScanHide.value = config.scanHide ? 1 : 0;
    u.uScanOnly.value = config.scanOnly ? 1 : 0;
    u.uNoiseScale.value = config.scanNoiseScale;
    u.uNoiseAmount.value = config.scanNoiseAmount;
    u.uSquare.value = config.pointSquare ? 1 : 0;
    u.uAspect.value = aspect;
  });

  if (!video) return null;
  return <points geometry={geometry} material={material} />;
}

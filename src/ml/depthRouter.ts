// Роутер источников глубины. Глубина «следует за входом» (файл/телефон/Kinect):
//  - файл / телефон → нейро-глубина (Depth Anything, useDepth);
//  - Kinect         → аппаратная глубина из хост-моста (useKinect).
// Оба провайдера отдают один контракт DepthApi (обёртка), поэтому рендер не меняется —
// он не знает, откуда пришла карта. ARKit/iPhone-LiDAR пока откладываем (мок-вход Kinect).

import type { DepthApi } from "./useDepth";

export type DepthInput = "file" | "stream" | "kinect";

export function depthRouter(input: DepthInput, neural: DepthApi, kinect: DepthApi): DepthApi {
  return input === "kinect" ? kinect : neural;
}

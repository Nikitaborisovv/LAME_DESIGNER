// Подтягиваем типы из основного пакета onnxruntime-web для webgpu-сабпаса
// (рантайм берёт меньший webgpu-бандл, типы у него те же).
declare module "onnxruntime-web/webgpu" {
  export * from "onnxruntime-common";
}

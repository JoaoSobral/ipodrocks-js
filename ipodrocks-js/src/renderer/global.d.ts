import type { IpcApi } from "@shared/types";

declare global {
  interface Window {
    api: IpcApi;
  }
}

declare module "@assets/*.png" {
  const src: string;
  export default src;
}
declare module "@assets/*.png?url" {
  const src: string;
  export default src;
}

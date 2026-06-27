/// <reference types="vite/client" />

interface Window {
  cockpitNative?: {
    pickFiles(): Promise<string[]>
    pickDirectory(): Promise<string[]>
  }
}

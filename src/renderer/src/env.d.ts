/// <reference types="vite/client" />
import type { KeyfallApi } from '../../preload'

declare global {
  interface Window {
    keyfall: KeyfallApi
  }
}

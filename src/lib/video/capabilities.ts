export const SUPPORTED_CAPABILITIES = {
  aRoll: ["zoom_in", "zoom_out", "punch_in", "speed_up", "slow_down"],
  bRoll: ["png_overlay", "image_overlay", "pip_layout", "split_layout"],
  audio: ["background_music", "sfx_short", "volume_ducking"],
  transitions: ["hard_cut", "cross_fade"],
  color: ["lut_filter", "exposure", "contrast"],
} as const;

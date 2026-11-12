export const SUPPORTED_CAPABILITIES = {
      aRoll: ["zoom_in", "zoom_out", "punch_in", "speed_up", "slow_down"],
        bRoll: ["png_overlay", "image_overlay", "pip_layout", "split_layout", "full_layout"],
          audio: ["background_music", "sfx_short"],
            transitions: ["hard_cut"],
              color: [] as const,
} as const;

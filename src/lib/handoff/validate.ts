import { z } from 'zod';

const HashtagsSchema = z.object({
  youtube: z.array(z.string()).max(15),
    instagram: z.array(z.string()).max(5, {
        message: 'IG max 5 hashtags (hard cap)',
          }),
            facebook: z.array(z.string()).max(10),
            });

            const ScriptSchema = z.object({
              hook: z.string().min(10).max(500),
                body: z.string().min(20).max(2000),
                  cta: z.string().min(10).max(500),
                    full: z.string().min(40).max(3000),
                      voice_match: z.number().min(0).max(100).nullable().optional(),
                        voice_level: z.number().min(0).max(3).optional(),
                        });

                        export const HandoffSchema = z.object({
                          creatoros_handoff: z.object({
                              version: z.literal('1.0'),
                                  handoff_id: z.string(),
                                      exported_at: z.string(),
                                          exported_from: z.string(),
                                              expires_at: z.string(),
                                                }),
                                                  brand: z.object({
                                                      name: z.string().min(1).max(50),
                                                          niche: z.string().min(1),
                                                              sub_niche: z.string().nullable().optional(),
                                                                  language: z.enum(['hindi', 'hinglish', 'english']),
                                                                      tone: z.string(),
                                                                          format: z.enum(['short', 'long']),
                                                                            }),
                                                                              content: z.object({
                                                                                  topic: z.string().min(3).max(200),
                                                                                      format: z.enum(['short', 'long']),
                                                                                          duration_target: z.number().min(5).max(3600),
                                                                                              script: ScriptSchema,
                                                                                                }),
                                                                                                  seo: z.object({
                                                                                                      primary_title: z.string().min(1).max(100),
                                                                                                          all_titles: z.array(z.string()).min(1).max(5),
                                                                                                              description: z.string().min(1).max(5000),
                                                                                                                  tags: z.array(z.string()).max(20),
                                                                                                                      hashtags: HashtagsSchema,
                                                                                                                          pinned_comment: z.string().max(500),
                                                                                                                              seo_score: z.number().min(0).max(100),
                                                                                                                                  best_time: z.object({
                                                                                                                                        day: z.string(),
                                                                                                                                              time: z.string(),
                                                                                                                                                    timezone: z.string(),
                                                                                                                                                          confidence: z.string(),
                                                                                                                                                              }).nullable().optional(),
                                                                                                                                                                }),
                                                                                                                                                                  broll_prompts: z.array(z.object({
                                                                                                                                                                      start: z.number(),
                                                                                                                                                                          end: z.number(),
                                                                                                                                                                              line: z.string(),
                                                                                                                                                                                  prompt: z.string(),
                                                                                                                                                                                    })).max(20).optional(),
                                                                                                                                                                                      thumbnail_prompts: z.array(z.object({
                                                                                                                                                                                          variant: z.string(),
                                                                                                                                                                                              recommended: z.boolean(),
                                                                                                                                                                                                  prompt: z.string(),
                                                                                                                                                                                                      text_overlay: z.object({
                                                                                                                                                                                                            main: z.string(),
                                                                                                                                                                                                                  sub: z.string(),
                                                                                                                                                                                                                      }),
                                                                                                                                                                                                                        })).max(5).optional(),
                                                                                                                                                                                                                          patterns_applied: z.array(z.object({
                                                                                                                                                                                                                              type: z.string(),
                                                                                                                                                                                                                                  name: z.string(),
                                                                                                                                                                                                                                      success_rate: z.number(),
                                                                                                                                                                                                                                        })).max(10).optional(),
                                                                                                                                                                                                                                          metadata: z.object({
                                                                                                                                                                                                                                              ai_disclosure: z.object({
                                                                                                                                                                                                                                                    required: z.boolean(),
                                                                                                                                                                                                                                                          reason: z.string(),
                                                                                                                                                                                                                                                              }),
                                                                                                                                                                                                                                                                  music_suggestion: z.object({
                                                                                                                                                                                                                                                                        mood: z.string().nullable(),
                                                                                                                                                                                                                                                                              youtube_only_tracks: z.array(z.string()),
                                                                                                                                                                                                                                                                                    cross_platform_tracks: z.array(z.string()),
                                                                                                                                                                                                                                                                                          license_required: z.boolean(),
                                                                                                                                                                                                                                                                                              }).optional(),
                                                                                                                                                                                                                                                                                                  voice_dna_profile: z.any().nullable().optional(),
                                                                                                                                                                                                                                                                                                      handoff_notes: z.string().max(500).optional(),
                                                                                                                                                                                                                                                                                                        }),
                                                                                                                                                                                                                                                                                                        });

                                                                                                                                                                                                                                                                                                        export type HandoffJSON = z.infer<typeof HashtagsSchema>;
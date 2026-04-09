export const PLATFORM_META = {
  github: {
    label: 'GitHub',
    host: 'github.com',
  },
  gitee: {
    label: 'Gitee',
    host: 'gitee.com',
  },
  gitlab: {
    label: 'GitLab',
    host: 'gitlab.com',
  },
} as const;

export type Platform = keyof typeof PLATFORM_META;

export const PLATFORMS = Object.keys(PLATFORM_META) as Platform[];

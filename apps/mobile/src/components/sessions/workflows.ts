/** Editable starting points: choosing a workflow fills a draft, it never sends a prompt. */
export const SESSION_WORKFLOWS = [
  {
    id: 'understand',
    title: 'Understand',
    hint: 'Map the project',
    icon: 'compass-outline',
    prompt: 'Read this project and explain how it works. Map the main files, user workflows, and how to run and test it.',
  },
  {
    id: 'improve',
    title: 'Improve',
    hint: 'Find the next step',
    icon: 'construct-outline',
    prompt:
      'Review this project and suggest the most useful improvements. Explain the tradeoffs and a concrete implementation plan before making changes.',
  },
  {
    id: 'review',
    title: 'Review',
    hint: 'Check recent changes',
    icon: 'git-compare-outline',
    prompt:
      'Review the uncommitted changes in this project. Look for bugs and regressions, run the relevant checks, and report findings with file references.',
  },
] as const;

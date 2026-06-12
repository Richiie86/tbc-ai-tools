/**
 * Project lifecycle stage definitions shared across ProjectsTab and its
 * extracted sub-components. Order matters — it's also the left-to-right tab
 * order and the "next stage" promotion order on cards.
 */
import { Code2, Lightbulb, Hammer, Rocket, Activity } from 'lucide-react';

export const STAGES = [
  {
    v: 'expand',
    label: 'Code to expand',
    short: 'Expand',
    Icon: Code2,
    accent: 'text-violet-300',
    pill:  'bg-violet-500/15 text-violet-200 border-violet-500/30',
    tile:  'bg-violet-500/10 text-violet-300',
    desc:  'Boilerplates, snippets, and reusable code you can clone into a new TBC build.',
  },
  {
    v: 'idea',
    label: 'Start new project',
    short: 'Idea',
    Icon: Lightbulb,
    accent: 'text-sky-300',
    pill:  'bg-sky-500/15 text-sky-200 border-sky-500/30',
    tile:  'bg-sky-500/10 text-sky-300',
    desc:  'Scoping & planning. Capture the pitch, target users, and rough stack.',
  },
  {
    v: 'dev',
    label: 'Under development',
    short: 'Dev',
    Icon: Hammer,
    accent: 'text-amber-300',
    pill:  'bg-amber-500/15 text-amber-200 border-amber-500/30',
    tile:  'bg-amber-500/10 text-amber-300',
    desc:  'Actively building. Track in-progress builds and their chat sessions.',
  },
  {
    v: 'launched',
    label: 'Launched',
    short: 'Launched',
    Icon: Rocket,
    accent: 'text-emerald-300',
    pill:  'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    tile:  'bg-emerald-500/10 text-emerald-300',
    desc:  'Shipped to the world. Capture launch URL + share assets.',
  },
  {
    v: 'running',
    label: 'Running',
    short: 'Running',
    Icon: Activity,
    accent: 'text-teal-300',
    pill:  'bg-teal-500/15 text-teal-200 border-teal-500/30',
    tile:  'bg-teal-500/10 text-teal-300',
    desc:  'Live & in maintenance — monitor and iterate without disruption.',
  },
];

export const stageOf = (v) => STAGES.find((s) => s.v === v) || STAGES[1];

export const EMPTY_PROJECT = {
  title: '', description: '', status: 'idea',
  tags: [], link_url: '', chat_session_id: '',
};

import { Smartphone, Monitor, Wand2 } from 'lucide-react';
import { useViewMode } from '../context/ViewModeContext';

const OPTIONS = [
  { value: 'auto', label: 'Auto', Icon: Wand2, hint: 'Follow my device' },
  { value: 'mobile', label: 'Mobile', Icon: Smartphone, hint: 'Phone layout' },
  { value: 'computer', label: 'Computer', Icon: Monitor, hint: 'Desktop layout' },
];

/**
 * A small floating segmented control, shown on every page, that lets anyone
 * pick Auto / Mobile / Computer layout. Sits bottom-center so it's reachable
 * with a thumb on phones and out of the way of most content.
 */
export default function ViewModeToggle() {
  const { mode, setMode } = useViewMode();

  return (
    <div
      role="group"
      aria-label="Choose layout: mobile or computer"
      className="fixed bottom-3 left-1/2 z-[60] -translate-x-1/2 flex items-center gap-1 rounded-full border border-tbc-900/70 bg-ink-900/95 p-1 shadow-lg backdrop-blur"
    >
      {OPTIONS.map(({ value, label, Icon, hint }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={active}
            title={hint}
            className={[
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-tbc-500 text-ink-950'
                : 'text-tbc-200/80 hover:bg-tbc-900/50 hover:text-tbc-100',
            ].join(' ')}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

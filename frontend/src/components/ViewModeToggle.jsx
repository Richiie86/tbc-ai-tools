import { Smartphone, Monitor, Wand2 } from 'lucide-react';
import { useViewMode } from '../context/ViewModeContext';

const OPTIONS = [
  { value: 'auto', label: 'Auto', Icon: Wand2, hint: 'Follow my device' },
  { value: 'mobile', label: 'Mobile', Icon: Smartphone, hint: 'Phone layout' },
  { value: 'computer', label: 'Computer', Icon: Monitor, hint: 'Desktop layout' },
];

/**
 * A compact inline segmented control that lets anyone pick Auto / Mobile /
 * Computer layout. It is mounted inside the Operator console and the user
 * Dashboard headers (rather than floating over the page) so it never overlaps
 * content or controls on phones. Labels collapse to icons on small screens to
 * keep the control narrow inside header rows.
 */
export default function ViewModeToggle({ className = '' }) {
  const { mode, setMode } = useViewMode();

  return (
    <div
      role="group"
      aria-label="Choose layout: auto, mobile, or computer"
      className={[
        'inline-flex items-center gap-1 rounded-full border border-tbc-900/70 bg-ink-900/95 p-1',
        className,
      ].join(' ')}
    >
      {OPTIONS.map(({ value, label, Icon, hint }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={active}
            aria-label={label}
            title={hint}
            className={[
              'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-tbc-500 text-ink-950'
                : 'text-tbc-200/80 hover:bg-tbc-900/50 hover:text-tbc-100',
            ].join(' ')}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

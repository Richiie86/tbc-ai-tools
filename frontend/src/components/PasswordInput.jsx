import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './ui/input';

/**
 * Password input with a show/hide eye toggle on the right.
 * Drop-in replacement for <Input type="password" .../>.
 *
 * Pass `testId` to give both the input and the toggle predictable test IDs.
 */
export default function PasswordInput({
  value,
  onChange,
  placeholder = '••••••••••',
  className = '',
  testId = 'password-input',
  autoFocus = false,
  autoComplete = 'current-password',
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        data-testid={testId}
        className={`pr-10 ${className}`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
        data-testid={`${testId}-toggle`}
        className="absolute right-2 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-tbc-300"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

import { useState } from 'react';

export default function ZipSearch() {
  const [zip, setZip] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{5}$/.test(zip)) {
      setError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    setError('');
    window.location.href = `/elections/lookup?zip=${zip}`;
  };

  return (
    <form onSubmit={handleSubmit} className="relative max-w-md mx-auto">
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{5}"
          maxLength={5}
          value={zip}
          onChange={(e) => {
            setZip(e.target.value.replace(/\D/g, ''));
            setError('');
          }}
          placeholder="Enter your ZIP code"
          className="flex-1 px-4 py-3 rounded-lg border border-slate-300 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
          aria-label="ZIP code"
        />
        <button
          type="submit"
          className="px-6 py-3 bg-civic-blue text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go
        </button>
      </div>
      {error && <p className="text-red-400 text-sm mt-2 absolute">{error}</p>}
    </form>
  );
}

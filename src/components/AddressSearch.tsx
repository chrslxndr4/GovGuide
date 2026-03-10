import { useState } from 'react';

interface AddressSearchProps {
  placeholder?: string;
  buttonText?: string;
  className?: string;
}

export default function AddressSearch({
  placeholder = 'Enter your full address (e.g. 1600 Pennsylvania Ave NW, Washington, DC 20500)',
  buttonText = 'Find My Reps',
  className = '',
}: AddressSearchProps) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = address.trim();
    if (trimmed.length < 5) {
      setError('Please enter a full street address with city and state.');
      return;
    }
    setError('');
    window.location.href = `/my-government?address=${encodeURIComponent(trimmed)}`;
  };

  return (
    <form onSubmit={handleSubmit} className={`relative ${className}`}>
      <div className="flex gap-2">
        <input
          type="text"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setError('');
          }}
          placeholder={placeholder}
          className="flex-1 px-4 py-3 rounded-lg border border-slate-200 text-sm text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          aria-label="Street address"
        />
        <button
          type="submit"
          className="px-5 py-3 bg-civic-blue text-white font-medium rounded-lg hover:bg-blue-700 transition-colors text-sm whitespace-nowrap"
        >
          {buttonText}
        </button>
      </div>
      {error && <p className="text-red-500 text-xs mt-1.5 absolute">{error}</p>}
    </form>
  );
}

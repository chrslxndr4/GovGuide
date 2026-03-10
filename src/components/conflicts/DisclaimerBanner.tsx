export default function DisclaimerBanner() {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-500 leading-relaxed">
      <p className="font-semibold text-slate-600 mb-1">Important Limitations</p>
      <ul className="list-disc list-inside space-y-0.5">
        <li>Stock trades are self-reported with up to 45-day filing delay</li>
        <li>Blind trusts are exempt from disclosure requirements</li>
        <li>Prediction market attribution is limited (pseudonymous wallets)</li>
        <li>Conflict flags represent statistical patterns, not proof of wrongdoing</li>
        <li>Correlation does not equal causation</li>
      </ul>
    </div>
  );
}

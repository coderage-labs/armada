interface StatCardProps {
  label: string;
  value: string | number;
  color?: string;
  icon?: string;
}

export default function StatCard({ label, value, color = 'text-zinc-100', icon }: StatCardProps) {
  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-zinc-400 text-sm font-medium">{label}</span>
        {icon && <span className="text-2xl">{icon}</span>}
      </div>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

"use client";

/**
 * Calibration: how often you're right at each confidence you state. The
 * diagonal is perfect calibration; a dot under it at 90% means "when I say
 * 90% I'm right less often than that" (overconfident). Dot size = answers.
 */
import type { Calibration } from "@/src/core";

const W = 260;
const H = 200;
const PAD = 28;

export function CalibrationChart({ data }: { data: Calibration }) {
	if (data.count < 3) {
		return (
			<p className="text-sm text-muted-foreground" data-testid="calibration-empty">
				Answer a few more checks with a confidence rating to see your calibration.
			</p>
		);
	}
	const x = (c: number) => PAD + (c / 100) * (W - PAD - 16);
	const y = (a: number) => H - PAD - a * (H - PAD - 8);
	const maxN = Math.max(...data.bins.map((b) => b.count));
	const bias = Math.round(data.bias ?? 0);
	const read =
		Math.abs(bias) < 5
			? "Your confidence matches how often you're right."
			: bias > 0
				? `You're overconfident: about ${bias} points more sure than you are right.`
				: `You're underconfident: you're right about ${-bias} points more often than you think.`;
	return (
		<figure className="flex flex-col items-center gap-3" data-testid="calibration-chart">
			<svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[22rem]" role="img" aria-label="Calibration chart: accuracy by stated confidence">
				{[0, 50, 100].map((t) => (
					<g key={t} className="text-muted-foreground" fill="currentColor" fontSize="9">
						<line x1={x(0)} x2={x(100)} y1={y(t / 100)} y2={y(t / 100)} stroke="currentColor" strokeOpacity="0.15" />
						<text x={PAD - 4} y={y(t / 100) + 3} textAnchor="end">{t}%</text>
						<text x={x(t)} y={H - PAD + 13} textAnchor="middle">{t}%</text>
					</g>
				))}
				<line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(1)} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="3 3" className="text-muted-foreground" />
				{data.bins.map((b) => (
					<circle
						key={b.confidence}
						cx={x(b.confidence)}
						cy={y(b.accuracy)}
						r={3 + 6 * Math.sqrt(b.count / maxN)}
						className="fill-primary"
						fillOpacity="0.85"
					>
						<title>{`${b.confidence}% sure: right ${Math.round(b.accuracy * 100)}% of ${b.count}`}</title>
					</circle>
				))}
				<text x={W / 2} y={H - 2} textAnchor="middle" fontSize="9" className="fill-muted-foreground">your confidence</text>
			</svg>
			<figcaption className="text-center text-sm text-muted-foreground">
				{read}
				<span className="mt-1 block font-mono text-xs">
					{data.count} rated answers · Brier {data.brier!.toFixed(2)} (0 is perfect, 0.25 is guessing)
				</span>
			</figcaption>
		</figure>
	);
}

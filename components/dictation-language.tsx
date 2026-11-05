"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	DICTATION_ENGINES, DICTATION_ENGINE_LABELS, DICTATION_LANGUAGES, FACTORY_SETTINGS, WHISPER_MODELS,
	isDictationEngine, isTranscriptionEndpointUrl, isWhisperModel, type DictationLanguage,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { CommitInput, SettingsMenuTrigger, SettingsRow, ThinSelect } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

type LanguagePreference = ReturnType<typeof useDictationLanguage>;

export function DictationLanguageSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label="Language" testid="row-dictation-language" dimmed={active}>
		<DictationLanguagePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

function DictationLanguagePicker({ preference, disabled }: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { language, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = DICTATION_LANGUAGES.find((item) => item.code === language)?.label ?? "—";

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-language-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (code: DictationLanguage) => {
		if (disabled || saving || language === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Dictation language: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-language"
				aria-label={`Dictation language: ${label}`}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (language === undefined) void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-language-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					// Empty search results must not submit the composer, but a
					// focused option button still needs Enter's native click.
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
				<SearchMenuList
					items={DICTATION_LANGUAGES}
					itemKey={(item) => item.code}
					searchTerms={(item) => [item.code, item.label]}
					isSelected={(item) => item.code === language}
					onPick={(item) => { void pick(item.code); }}
					disabled={saving || language === undefined}
					searchTestid="dictation-language-search"
					listTestid="dictation-language-list"
					optionTestid={(item) => `dictation-language-${item.code}`}
					ariaLabel="Search dictation languages"
					placeholder="Search languages…"
					empty="No languages match."
					renderItem={(item) => <span className="text-card-foreground">{item.label}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}

/** Engine choice plus the active engine's own settings. Every change is one
 *  section PUT through the shared preference store; locked while a run is live. */
export function DictationEngineSettings() {
	const { section, language, saving, error, save } = useDictationLanguage();
	const active = useDictationActive();
	const engine = section.engine ?? FACTORY_SETTINGS.dictation.engine;
	const whisperModel = section.whisperModel ?? FACTORY_SETTINGS.dictation.whisperModel;
	const locked = active || saving || language === undefined;
	const [urlError, setUrlError] = useState<string | null>(null);

	return <>
		<SettingsRow label="Engine" testid="row-dictation-engine" dimmed={active} hint={error ?? undefined}>
			<ThinSelect
				value={engine}
				ariaLabel="Dictation engine"
				testid="dictation-engine"
				disabled={locked}
				onChange={(next) => {
					if (!isDictationEngine(next)) return;
					void save({ engine: next }).then((ok) => {
						// Start the one-time model download as soon as Whisper is chosen.
						if (ok && next === "whisper") void fetch("/api/stt/transcribe").catch(() => {});
					});
				}}
			>
				{DICTATION_ENGINES.map((id) => <option key={id} value={id}>{DICTATION_ENGINE_LABELS[id]}</option>)}
			</ThinSelect>
		</SettingsRow>
		{engine === "whisper" && <SettingsRow label="Whisper model" hint="Larger is more accurate but slower" testid="row-dictation-whisper-model" dimmed={active}>
			<ThinSelect
				value={whisperModel}
				ariaLabel="Whisper model"
				testid="dictation-whisper-model"
				disabled={locked}
				onChange={(next) => {
					if (!isWhisperModel(next)) return;
					void save({ whisperModel: next }).then((ok) => {
						if (ok) void fetch("/api/stt/transcribe").catch(() => {});
					});
				}}
			>
				{WHISPER_MODELS.map((m) => <option key={m.id} value={m.id}>{`${m.label} (${m.size})`}</option>)}
			</ThinSelect>
		</SettingsRow>}
		{engine === "endpoint" && <>
			<SettingsRow label="Endpoint URL" hint={urlError ?? "e.g. http://127.0.0.1:8080/v1"} testid="row-dictation-endpoint-url" dimmed={active}>
				<CommitInput
					value={section.endpointUrl ?? ""}
					placeholder="http://127.0.0.1:8080/v1"
					ariaLabel="Transcription endpoint URL"
					testid="dictation-endpoint-url"
					onCommit={(next) => {
						if (locked) return;
						if (next && !isTranscriptionEndpointUrl(next)) { setUrlError("Enter an http(s) URL"); return; }
						setUrlError(null);
						void save({ endpointUrl: next || undefined });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Endpoint model" testid="row-dictation-endpoint-model" dimmed={active}>
				<CommitInput
					value={section.endpointModel ?? ""}
					placeholder="whisper-1"
					ariaLabel="Transcription endpoint model"
					testid="dictation-endpoint-model"
					onCommit={(next) => { if (!locked) void save({ endpointModel: next || undefined }); }}
				/>
			</SettingsRow>
		</>}
	</>;
}

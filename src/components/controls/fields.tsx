import { useEffect, useId, useState } from "react";
import {
	ACTIONS,
	type Action,
	isAction,
	isProfileName,
	isVerdict,
	PROFILE_NAMES,
	type ProfileName,
	VERDICTS,
	type Verdict,
} from "#/components/controls/options.ts";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";

/** Native checkbox + label switch (no extra dependencies). */
export function CheckRow({
	checked,
	label,
	onChange,
}: {
	checked: boolean;
	label: string;
	onChange: (next: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2">
			<input
				checked={checked}
				className="size-4"
				id={id}
				onChange={(event) => onChange(event.target.checked)}
				type="checkbox"
			/>
			<label className="text-sm font-medium" htmlFor={id}>
				{label}
			</label>
		</div>
	);
}

/**
 * Text input with a local buffer: typing stays local and commits on blur, so
 * rows keyed by the committed value never remount mid-edit and lose focus.
 */
export function BufferedInput({
	ariaLabel,
	className,
	onCommit,
	placeholder,
	spellCheck,
	value,
}: {
	ariaLabel: string;
	className?: string;
	onCommit: (next: string) => void;
	placeholder?: string;
	spellCheck?: boolean;
	value: string;
}) {
	const [text, setText] = useState(value);
	useEffect(() => {
		setText(value);
	}, [value]);
	return (
		<input
			aria-label={ariaLabel}
			className={className}
			onBlur={() => {
				if (text !== value) {
					onCommit(text);
				}
			}}
			onChange={(event) => setText(event.target.value)}
			placeholder={placeholder}
			spellCheck={spellCheck}
			value={text}
		/>
	);
}

export function OptionSelect({
	label,
	onChange,
	options,
	value,
}: {
	label: string;
	onChange: (next: string) => void;
	options: readonly string[];
	value: string;
}) {
	return (
		<Select onValueChange={onChange} value={value}>
			<SelectTrigger aria-label={label} className="w-44">
				<SelectValue placeholder={label} />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option} value={option}>
						{option}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function ActionSelect({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (next: Action) => void;
	value: Action;
}) {
	return (
		<OptionSelect
			label={label}
			onChange={(next) => {
				if (isAction(next)) {
					onChange(next);
				}
			}}
			options={ACTIONS}
			value={value}
		/>
	);
}

export function ProfileSelect({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (next: ProfileName) => void;
	value: ProfileName;
}) {
	return (
		<OptionSelect
			label={label}
			onChange={(next) => {
				if (isProfileName(next)) {
					onChange(next);
				}
			}}
			options={PROFILE_NAMES}
			value={value}
		/>
	);
}

export function VerdictSelect({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (next: Verdict) => void;
	value: Verdict;
}) {
	return (
		<OptionSelect
			label={label}
			onChange={(next) => {
				if (isVerdict(next)) {
					onChange(next);
				}
			}}
			options={VERDICTS}
			value={value}
		/>
	);
}

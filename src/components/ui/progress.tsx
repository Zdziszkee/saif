"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "#/lib/utils.ts";

/** Full-width percentage used for the indicator translate transform. */
const PERCENT_MAX = 100;

function Progress({
	className,
	value,
	...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
	return (
		<ProgressPrimitive.Root
			className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
			data-slot="progress"
			{...props}
		>
			<ProgressPrimitive.Indicator
				className="h-full w-full flex-1 bg-primary transition-all"
				data-slot="progress-indicator"
				style={{ transform: `translateX(-${PERCENT_MAX - (value || 0)}%)` }}
			/>
		</ProgressPrimitive.Root>
	);
}

export { Progress };

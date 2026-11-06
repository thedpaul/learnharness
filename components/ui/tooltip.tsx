"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The styled tooltip (tooltip wave → subtlety round, owner 2026-09-25):
 * a quiet dark chip, not a white slab — accent tone (the hover-chip color),
 * 11px, minimal padding, no arrow (nothing purely decorative). Opens after
 * a 500ms rest, so tooltips appear when you pause on a control, never in
 * passing; disableHoverableContent means the chip is un-hoverable — the
 * instant the cursor leaves the trigger it's gone, even mid-move onto the
 * chip's own pixels.
 */

/** The rest delay (ms): shared by hover and focus opens. */
export const TOOLTIP_DELAY_MS = 500

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/** A tap is not a hover: touch browsers follow a tap with compat mouse
 *  events and focus, which Radix reads as a hover/focus open — the label
 *  (with its desktop shortcut) flashed under the finger and every tap paid
 *  for a popper mount. Opens within this window of a touch are ignored;
 *  mouse hover and keyboard focus open as before. */
export const TOUCH_SUPPRESS_MS = 1000

let lastTouchAt = -Infinity
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") lastTouchAt = performance.now()
    },
    { capture: true, passive: true }
  )
}

/** True while a touch is recent enough that an open came from it. */
export function openedByTouch(now = performance.now()): boolean {
  return now - lastTouchAt < TOUCH_SUPPRESS_MS
}

function Tooltip({
  disableHoverableContent = true,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen)
  const open = openProp ?? ownOpen
  const change = React.useCallback(
    (next: boolean) => {
      if (next && openedByTouch()) return
      if (openProp === undefined) setOwnOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverableContent={disableHoverableContent}
      open={open}
      onOpenChange={change}
      {...props}
    />
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-accent px-2 py-1 text-[11px] text-foreground/85 text-balance fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
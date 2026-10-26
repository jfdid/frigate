import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { SHUTTLE_SPEEDS } from "@/hooks/use-shuttle";
import { cn } from "@/lib/utils";

// slider stops, left to right: reverse fastest to slowest, pause, then
// forward slowest to fastest
const STOPS = [
  ...SHUTTLE_SPEEDS.map((speed) => -speed).reverse(),
  0,
  ...SHUTTLE_SPEEDS,
];
const CENTER = SHUTTLE_SPEEDS.length;

/** The stop closest to a rate, e.g. the speed menu's 0.5x shows at 1x. */
function stopForRate(rate: number): number {
  if (rate == 0) {
    return CENTER;
  }

  let best = rate > 0 ? CENTER + 1 : CENTER - 1;

  STOPS.forEach((stop, index) => {
    if (
      Math.sign(stop) == Math.sign(rate) &&
      Math.abs(Math.log2(Math.abs(stop) / Math.abs(rate))) <
        Math.abs(Math.log2(Math.abs(STOPS[best]) / Math.abs(rate)))
    ) {
      best = index;
    }
  });

  return best;
}

type ShuttleSliderProps = {
  className?: string;
  // negative plays in reverse, 0 is paused
  rate: number;
  isLive: boolean;
  disabled?: boolean;
  onRateChange: (rate: number) => void;
};

/**
 * A Blue Iris style shuttle: paused in the middle, forward to the right and
 * reverse to the left, faster the further from the middle.
 */
export default function ShuttleSlider({
  className,
  rate,
  isLive,
  disabled = false,
  onRateChange,
}: ShuttleSliderProps) {
  const { t } = useTranslation(["views/events"]);
  const stop = isLive ? CENTER : stopForRate(rate);

  const label = useMemo(() => {
    if (isLive) {
      return t("liveEdge.handlebar");
    }

    if (rate == 0) {
      return t("shuttle.paused");
    }

    return rate > 0
      ? t("shuttle.forward", { rate })
      : t("shuttle.reverse", { rate: -rate });
  }, [isLive, rate, t]);

  return (
    <div
      className={cn("flex w-full items-center gap-3 px-2", className)}
      data-testid="shuttle"
      data-rate={isLive ? "live" : rate}
    >
      <div className="relative flex-1">
        {/* the pause position */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-muted-foreground" />
        {/* no filled range: the ui Slider fills from the left edge, which
            reads as an amount rather than a distance from the middle */}
        <SliderPrimitive.Root
          className="relative flex w-full touch-none select-none items-center"
          aria-label={t("shuttle.label")}
          min={0}
          max={STOPS.length - 1}
          step={1}
          value={[stop]}
          disabled={disabled}
          onValueChange={([value]) => {
            if (value != stop) {
              onRateChange(STOPS[value]);
            }
          }}
        >
          <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary" />
          <SliderPrimitive.Thumb className="block h-5 w-5 cursor-pointer rounded-full border-2 border-primary bg-primary ring-offset-background transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
        </SliderPrimitive.Root>
      </div>
      <div
        className={cn(
          "w-16 shrink-0 text-right text-sm tabular-nums",
          isLive && "font-medium text-destructive",
        )}
        data-testid="shuttle-label"
      >
        {label}
      </div>
    </div>
  );
}

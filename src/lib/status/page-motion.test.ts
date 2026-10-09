import { describe, expect, it } from "vitest";
import { createMotionTracker, SETTLE_MS, TOUCH_EXPIRES_MS, TOUCH_POLL_MS } from "./page-motion";

function tracker() {
  let at = 1_000_000;
  const motion = createMotionTracker(() => at);
  const advance = (ms: number) => {
    at += ms;
  };
  return { motion, advance };
}

describe("createMotionTracker", () => {
  it("is at rest before anything happens", () => {
    const { motion } = tracker();
    expect(motion.moving()).toBe(false);
    expect(motion.restsIn()).toBe(0);
  });

  it("counts a scroll as motion for SETTLE_MS after its last event, and not a moment more", () => {
    const { motion, advance } = tracker();
    motion.scrolled();
    expect(motion.moving()).toBe(true);
    expect(motion.restsIn()).toBe(SETTLE_MS);
    advance(SETTLE_MS - 1);
    expect(motion.moving()).toBe(true);
    expect(motion.restsIn()).toBe(1);
    // Another event starts the wait over.
    motion.scrolled();
    advance(SETTLE_MS - 1);
    expect(motion.moving()).toBe(true);
    advance(1);
    expect(motion.moving()).toBe(false);
    expect(motion.restsIn()).toBe(0);
  });

  it("counts a finger as motion while it is down, scroll events or none, and for SETTLE_MS after the lift", () => {
    const { motion, advance } = tracker();
    motion.touched(1);
    advance(2_000);
    expect(motion.moving()).toBe(true);
    expect(motion.restsIn()).toBe(TOUCH_POLL_MS);
    // The lift: no finger left on the screen. Without a scroll the page is at rest at once; a drag's last scroll
    // event is what keeps it moving a moment longer.
    motion.scrolled();
    motion.touched(0);
    expect(motion.moving()).toBe(true);
    advance(SETTLE_MS);
    expect(motion.moving()).toBe(false);
  });

  it("keeps counting while a second finger is down after the first lifts", () => {
    const { motion } = tracker();
    motion.touched(2);
    motion.touched(1);
    expect(motion.moving()).toBe(true);
    motion.touched(0);
    expect(motion.moving()).toBe(false);
  });

  it("takes a finger that has sent nothing for TOUCH_EXPIRES_MS to have lifted", () => {
    const { motion, advance } = tracker();
    motion.touched(1);
    advance(TOUCH_EXPIRES_MS);
    expect(motion.moving()).toBe(true);
    advance(1);
    expect(motion.moving()).toBe(false);
    expect(motion.restsIn()).toBe(0);
  });

  it("forgets everything on reset", () => {
    const { motion } = tracker();
    motion.touched(1);
    motion.scrolled();
    motion.reset();
    expect(motion.moving()).toBe(false);
  });
});

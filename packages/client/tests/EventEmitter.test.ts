import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "../src/EventEmitter.js";

type Events = { greet: string; count: number };

describe("EventEmitter", () => {
  it("emits to registered listeners", () => {
    const ee = new EventEmitter<Events>();
    const fn = vi.fn();
    ee.on("greet", fn);
    ee.emit("greet", "hello");
    expect(fn).toHaveBeenCalledWith("hello");
  });

  it("supports multiple listeners on the same event", () => {
    const ee = new EventEmitter<Events>();
    const a = vi.fn(), b = vi.fn();
    ee.on("greet", a).on("greet", b);
    ee.emit("greet", "hi");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("on() returns this for chaining", () => {
    const ee = new EventEmitter<Events>();
    expect(ee.on("greet", () => {})).toBe(ee);
  });

  it("off() removes a specific listener", () => {
    const ee = new EventEmitter<Events>();
    const fn = vi.fn();
    ee.on("greet", fn);
    ee.off("greet", fn);
    ee.emit("greet", "hi");
    expect(fn).not.toHaveBeenCalled();
  });

  it("once() fires exactly once then unregisters", () => {
    const ee = new EventEmitter<Events>();
    const fn = vi.fn();
    ee.once("count", fn);
    ee.emit("count", 1);
    ee.emit("count", 2);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("removeAllListeners() clears all events", () => {
    const ee = new EventEmitter<Events>();
    const fn = vi.fn();
    ee.on("greet", fn).on("count", fn);
    ee.removeAllListeners();
    ee.emit("greet", "hi");
    ee.emit("count", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not throw when emitting with no listeners", () => {
    const ee = new EventEmitter<Events>();
    expect(() => ee.emit("greet", "hi")).not.toThrow();
  });
});

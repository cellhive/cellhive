/**
 * The latest value of something that changes while a long-lived object
 * (edit controller, refresher) reads it: set after each render, read when
 * the object runs, never during render.
 */
export class Latest<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
  }
}

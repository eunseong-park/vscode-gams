// SPDX-License-Identifier: GPL-3.0-or-later
// Search highlight state shared by the grids and the search bar.
import { makeMatcher, SearchOptions } from '../search';

let matcher: ((s: string) => boolean) | undefined;
let active: { r: number; c: number } | undefined;

export function setSearchOptions(o: SearchOptions): void {
  matcher = makeMatcher(o);
  active = undefined;
}
export const hasMatcher = (): boolean => matcher !== undefined;
export const isMatchText = (text: string): boolean => !!matcher && text !== '' && matcher(text);
export const testMatch = (text: string): boolean => !!matcher && matcher(text);
export const activeMatch = (): { r: number; c: number } | undefined => active;
export function setActiveMatch(c: { r: number; c: number } | undefined): void {
  active = c;
}

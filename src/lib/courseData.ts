/**
 * Course data loader — loads module JSON files and resolves image paths.
 */
import type { ImageSourcePropType } from "react-native";

// Static imports for all module JSON files
import m1 from "../data/course/m1.json";
import m2 from "../data/course/m2.json";
import m3 from "../data/course/m3.json";
import m4 from "../data/course/m4.json";
import m5 from "../data/course/m5.json";
import m6 from "../data/course/m6.json";
import m7 from "../data/course/m7.json";
import m8 from "../data/course/m8.json";

export interface QuizQuestion {
  question: string;
  options: string[];
  correct: number;
}

export interface Subsection {
  id: string;
  title: string;
  content: string;
  images?: string[];
}

export interface Section {
  id: string;
  title: string;
  content: string;
  images?: string[];
  subsections?: Subsection[];
  quiz?: QuizQuestion[];
}

export interface Module {
  id: string;
  title: string;
  description: string;
  sections: Section[];
}

const MODULES: Record<string, Module> = {
  m1: m1 as Module,
  m2: m2 as Module,
  m3: m3 as Module,
  m4: m4 as Module,
  m5: m5 as Module,
  m6: m6 as Module,
  m7: m7 as Module,
  m8: m8 as Module,
};

export function getModule(id: string): Module | null {
  return MODULES[id] ?? null;
}

export function getAllModules(): Module[] {
  return Object.values(MODULES);
}

// Image map — static requires for each module's images
// We can't dynamically require in React Native, so we map known images
const IMAGE_MAP: Record<string, Record<string, ImageSourcePropType>> = {};

// For now, images are loaded by require at build time.
// Since we can't enumerate dynamically, we provide a fallback.
// In the future, images should be served from a local asset server or bundled.
export function getImageSource(
  moduleId: string,
  filename: string
): ImageSourcePropType | null {
  // React Native can't do dynamic requires, so we return null for now.
  // Images will be implemented when we move to a web-served approach
  // or pre-generate the require map.
  return null;
}

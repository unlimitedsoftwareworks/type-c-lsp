import { prototypes } from "./prototypes.js";
export const libraryScheme = "tcd";
export const prototypeURI = libraryScheme + ":/prototypes.tc";
export const builtins = {
    [prototypeURI]: prototypes,
}
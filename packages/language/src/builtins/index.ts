import { prototypes } from "./prototypes.js";
export const libraryScheme = "builtin";
export const prototypeURI = libraryScheme + ":/prototypes.tc";
export const builtins = {
    libraryScheme,
    [prototypeURI]: prototypes,
}
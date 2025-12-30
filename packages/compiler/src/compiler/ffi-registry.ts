export class FFIRegistery {
    counter: number = 0;
    map: Map<string, number> = new Map();

    has(name: string) {
        return this.map.has(name)
    }

    register(name: string) {
        const oldCounter = this.counter;
        this.counter++;
        this.map.set(name, oldCounter);
        return oldCounter;
    }

    get(name: string): number {
        if(this.map.has(name)) {
            return this.map.get(name)!;
        }

        throw `Lib ${name} was not registered.`
    }
}
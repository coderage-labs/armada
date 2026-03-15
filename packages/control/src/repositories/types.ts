export interface Repository<T, CreateT = Partial<T>, UpdateT = Partial<T>> {
  findById(id: string): T | null;
  findAll(filter?: Record<string, unknown>): T[];
  create(data: CreateT): T;
  update(id: string, data: UpdateT): T | null;
  delete(id: string): boolean;
}

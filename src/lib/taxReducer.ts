import { TaxState } from './types';
import { initialState } from './taxState';

export type TaxAction =
  | { type: 'SET_STEP'; payload: number }
  | { type: 'UPDATE_MODULES'; payload: Partial<TaxState['modules']> }
  | { type: 'UPDATE_SITUATION'; payload: Partial<TaxState['situationPersonnelle']> }
  | { type: 'UPDATE_SALAIRES'; payload: Partial<TaxState['revenusSalariaux']> }
  | { type: 'UPDATE_REMPLACEMENT'; payload: Partial<TaxState['revenusRemplacement']> }
  | { type: 'UPDATE_INDEPENDANT'; payload: Partial<TaxState['revenusIndependant']> }
  | { type: 'UPDATE_FONCIERS'; payload: Partial<TaxState['revenusFonciers']> }
  | { type: 'UPDATE_LMNP'; payload: Partial<TaxState['revenusLMNP']> }
  | { type: 'UPDATE_SCI'; payload: Partial<TaxState['revenusSCI']> }
  | { type: 'UPDATE_PATRIMOINE'; payload: Partial<TaxState['revenusPatrimoine']> }
  | { type: 'UPDATE_CHARGES'; payload: Partial<TaxState['chargesDeductibles']> }
  | { type: 'UPDATE_REDUCTIONS'; payload: Partial<TaxState['reductionsCreditImpot']> }
  | { type: 'UPDATE_IFI'; payload: Partial<TaxState['ifi']> }
  | { type: 'RESET' }
  | { type: 'LOAD'; payload: TaxState };

export function taxReducer(state: TaxState, action: TaxAction): TaxState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.payload };

    case 'UPDATE_MODULES':
      return { ...state, modules: { ...state.modules, ...action.payload } };

    case 'UPDATE_SITUATION':
      return { ...state, situationPersonnelle: { ...state.situationPersonnelle, ...action.payload } };

    case 'UPDATE_SALAIRES':
      return { ...state, revenusSalariaux: { ...state.revenusSalariaux, ...action.payload } };

    case 'UPDATE_REMPLACEMENT':
      return { ...state, revenusRemplacement: { ...state.revenusRemplacement, ...action.payload } };

    case 'UPDATE_INDEPENDANT':
      return { ...state, revenusIndependant: { ...state.revenusIndependant, ...action.payload } };

    case 'UPDATE_FONCIERS':
      return { ...state, revenusFonciers: { ...state.revenusFonciers, ...action.payload } };

    case 'UPDATE_LMNP':
      return { ...state, revenusLMNP: { ...state.revenusLMNP, ...action.payload } };

    case 'UPDATE_SCI':
      return { ...state, revenusSCI: { ...state.revenusSCI, ...action.payload } };

    case 'UPDATE_PATRIMOINE':
      return { ...state, revenusPatrimoine: { ...state.revenusPatrimoine, ...action.payload } };

    case 'UPDATE_CHARGES':
      return { ...state, chargesDeductibles: { ...state.chargesDeductibles, ...action.payload } };

    case 'UPDATE_REDUCTIONS':
      return { ...state, reductionsCreditImpot: { ...state.reductionsCreditImpot, ...action.payload } };

    case 'UPDATE_IFI':
      return { ...state, ifi: { ...state.ifi, ...action.payload } };

    case 'RESET':
      return initialState;

    case 'LOAD':
      return action.payload;

    default:
      return state;
  }
}

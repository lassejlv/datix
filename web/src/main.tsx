import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { getRouter } from './router';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Datix could not find the application root.');

createRoot(root).render(<RouterProvider router={getRouter()} />);

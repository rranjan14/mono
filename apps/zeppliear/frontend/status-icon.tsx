import CancelIcon from './assets/icons/cancel.svg';
import BacklogIcon from './assets/icons/circle-dot.svg';
import TodoIcon from './assets/icons/circle.svg';
import DoneIcon from './assets/icons/done.svg';
import InProgressIcon from './assets/icons/half-circle.svg';
import classNames from 'classnames';
import {Status} from './issue';

interface Props {
  status: Status;
  className?: string;
}

const getStatusIcon = (issueStatus: Status, className?: string) => {
  const classes = classNames('w-3.8 h-3.8 rounded', className);

  switch (issueStatus) {
    case Status.Backlog:
      return <BacklogIcon className={classes} />;
    case Status.Todo:
      return <TodoIcon className={classes} />;
    case Status.InProgress:
      return <InProgressIcon className={classes} />;
    case Status.Done:
      return <DoneIcon className={classes} />;
    case Status.Canceled:
      return <CancelIcon className={classes} />;
    default:
      return <BacklogIcon className={classes} />;
  }
};

export default function StatusIcon({status, className}: Props) {
  return getStatusIcon(status, className);
}